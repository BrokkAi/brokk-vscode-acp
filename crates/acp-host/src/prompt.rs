use agent_client_protocol::schema::v1::{ContentBlock, ImageContent, TextContent};
use anyhow::{Result, anyhow};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;

pub const MAX_PROMPT_IMAGES: usize = 4;
pub const MAX_PROMPT_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_PROMPT_IMAGE_TOTAL_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptImage {
    pub data: String,
    pub mime_type: String,
}

pub fn content_blocks(
    text: String,
    images: Vec<PromptImage>,
    image_supported: bool,
) -> Result<Vec<ContentBlock>> {
    if images.len() > MAX_PROMPT_IMAGES {
        return Err(anyhow!(
            "attach at most {MAX_PROMPT_IMAGES} images to one prompt"
        ));
    }
    if !images.is_empty() && !image_supported {
        return Err(anyhow!(
            "this ACP agent does not advertise image prompt support"
        ));
    }

    let mut content = Vec::with_capacity(usize::from(!text.trim().is_empty()) + images.len());
    if !text.trim().is_empty() {
        content.push(ContentBlock::Text(TextContent::new(text)));
    }

    let mut total_bytes = 0;
    for (index, image) in images.into_iter().enumerate() {
        let number = index + 1;
        if !matches!(
            image.mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) {
            return Err(anyhow!("image {number} must be PNG, JPEG, GIF, or WebP"));
        }
        let max_encoded_len = 4 * MAX_PROMPT_IMAGE_BYTES.div_ceil(3);
        if image.data.len() > max_encoded_len {
            return Err(anyhow!("image {number} exceeds the 10 MB limit"));
        }
        let decoded = STANDARD
            .decode(&image.data)
            .map_err(|_| anyhow!("image {number} is not valid base64"))?;
        if decoded.len() > MAX_PROMPT_IMAGE_BYTES {
            return Err(anyhow!("image {number} exceeds the 10 MB limit"));
        }
        if !has_expected_signature(&image.mime_type, &decoded) {
            return Err(anyhow!("image {number} does not match its declared format"));
        }
        total_bytes += decoded.len();
        if total_bytes > MAX_PROMPT_IMAGE_TOTAL_BYTES {
            return Err(anyhow!("image attachments exceed the 20 MB total limit"));
        }
        content.push(ContentBlock::Image(ImageContent::new(
            image.data,
            image.mime_type,
        )));
    }

    if content.is_empty() {
        return Err(anyhow!("a prompt needs text or at least one image"));
    }
    Ok(content)
}

fn has_expected_signature(mime_type: &str, data: &[u8]) -> bool {
    match mime_type {
        "image/png" => data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => data.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a"),
        "image/webp" => {
            data.starts_with(b"RIFF") && data.get(8..12).is_some_and(|value| value == b"WEBP")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(mime_type: &str, bytes: &[u8]) -> PromptImage {
        PromptImage {
            data: STANDARD.encode(bytes),
            mime_type: mime_type.into(),
        }
    }

    #[test]
    fn builds_text_and_supported_image_content() {
        let cases: [(&str, &[u8]); 4] = [
            ("image/png", &[137, 80, 78, 71, 13, 10, 26, 10]),
            ("image/jpeg", &[0xff, 0xd8, 0xff]),
            ("image/gif", b"GIF89a"),
            ("image/webp", b"RIFFsizeWEBP"),
        ];
        for (mime_type, bytes) in cases {
            let content = content_blocks("describe".into(), vec![image(mime_type, bytes)], true)
                .expect("valid prompt");
            assert_eq!(content.len(), 2);
            assert!(matches!(&content[0], ContentBlock::Text(value) if value.text == "describe"));
            assert!(
                matches!(&content[1], ContentBlock::Image(value) if value.mime_type == mime_type)
            );
        }
    }

    #[test]
    fn accepts_an_image_only_prompt() {
        let content = content_blocks("  ".into(), vec![image("image/gif", b"GIF87a")], true)
            .expect("image prompt");
        assert_eq!(content.len(), 1);
        assert!(matches!(&content[0], ContentBlock::Image(_)));
    }

    #[test]
    fn rejects_unsupported_or_malformed_images_and_empty_prompts() {
        assert!(
            content_blocks(
                "text".into(),
                vec![image("image/png", &[137, 80, 78, 71, 13, 10, 26, 10])],
                false,
            )
            .expect_err("capability")
            .to_string()
            .contains("does not advertise")
        );
        assert!(
            content_blocks("text".into(), vec![image("image/svg+xml", b"<svg>")], true,)
                .expect_err("mime")
                .to_string()
                .contains("must be PNG")
        );
        assert!(
            content_blocks(
                "text".into(),
                vec![PromptImage {
                    data: "not-base64".into(),
                    mime_type: "image/png".into(),
                }],
                true,
            )
            .expect_err("base64")
            .to_string()
            .contains("valid base64")
        );
        assert!(
            content_blocks("text".into(), vec![image("image/png", b"not png")], true,)
                .expect_err("signature")
                .to_string()
                .contains("declared format")
        );
        assert!(
            content_blocks(String::new(), Vec::new(), true)
                .expect_err("empty")
                .to_string()
                .contains("needs text")
        );
        assert!(
            content_blocks(
                "text".into(),
                vec![image("image/gif", b"GIF89a"); MAX_PROMPT_IMAGES + 1],
                true,
            )
            .expect_err("count")
            .to_string()
            .contains("at most")
        );
    }
}
