export const DESCRIBE_IMAGE_DESCRIPTION = `Describe a local image using the configured Vision model and return plain text.

This is a fallback tool, not the normal way to inspect images.
- Use it only after an image tool result explicitly says the current protocol cannot provide the image, or the main model has explicitly reported that it cannot inspect the image.
- The task must actually require understanding that image. Do not call this tool merely because a file path or an image exists.
- Do not use it for ordinary image inputs or tool images that the main model can already inspect.
- Pass the absolute local path of that same image. Never invent a path, download an image, or describe an unrelated file.
- The returned description is produced by a separate Vision model. Do not claim that you directly inspected the original image.
- If this tool fails, explain that the image content was not understood and suggest a suitable image-capable model/protocol. Do not repeatedly call it without a reason.

Supported images: PNG, JPEG, GIF, and WebP. No image-description cache is used.`;
