use agent_client_protocol::schema::v1::{ContentBlock, ImageContent, TextContent};
use anyhow::{Result, anyhow};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Deserialize;

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
    if !images.is_empty() && !image_supported {
        return Err(anyhow!(
            "this ACP agent does not advertise image prompt support"
        ));
    }

    let mut content = Vec::with_capacity(usize::from(!text.trim().is_empty()) + images.len());
    if !text.trim().is_empty() {
        content.push(ContentBlock::Text(TextContent::new(text)));
    }

    for (index, image) in images.into_iter().enumerate() {
        let number = index + 1;
        let mime_type = image.mime_type.trim().to_ascii_lowercase();
        if !mime_type.starts_with("image/") || mime_type.len() == "image/".len() {
            return Err(anyhow!("image {number} must have an image MIME type"));
        }
        STANDARD
            .decode(&image.data)
            .map_err(|_| anyhow!("image {number} is not valid base64"))?;
        content.push(ContentBlock::Image(ImageContent::new(
            image.data, mime_type,
        )));
    }

    if content.is_empty() {
        return Err(anyhow!("a prompt needs text or at least one image"));
    }
    Ok(content)
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
    fn builds_text_and_any_image_content() {
        let cases: [(&str, &[u8]); 3] = [
            ("image/png", b"not signature inspected"),
            ("image/heic", b"arbitrary image bytes"),
            ("image/svg+xml", b"<svg/>"),
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
            content_blocks("text".into(), vec![image("application/pdf", b"%PDF")], true,)
                .expect_err("mime")
                .to_string()
                .contains("image MIME type")
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
            content_blocks(String::new(), Vec::new(), true)
                .expect_err("empty")
                .to_string()
                .contains("needs text")
        );
    }

    #[test]
    fn accepts_many_images_without_client_policy() {
        let images = (0..12)
            .map(|index| image("image/x-custom", &[index]))
            .collect();
        let content = content_blocks("text".into(), images, true).expect("many images");
        assert_eq!(content.len(), 13);
    }
}
