# Classic Google Images

![Classic Google Images icon](icon/128.png)

A Chrome and Brave extension with a spacious classic preview panel for Google Images. Current version: **2.6.0**.

## Features

- Resizable horizontal or right-side vertical preview with dark charcoal, white and sepia themes.
- Illustrated Horizontal, Vertical and Auto layout selector, with vertical as the default for new installs. Auto follows the image shape and uses your chosen default for near-square images.
- Google collection Save and Google Lens controls beside close and navigation.
- Vertical preview prioritizes image size, with copy icons in the top row and neighboring-image previews below the title and URL; choose the layout in the toolbar popup. The collage reflows beside it as you resize, with preview width capped at 75% of the window.
- Original image URLs when available, with thumbnail fallback.
- Copy photo URL and copy image buttons.
- Previous and next image previews, without wrapping at the ends.
- Arrow key navigation at up to four images per second and preloading of the next four images.
- Adjustable enlargement cap, defaulting to 2×.

## Install locally

1. Download the source or release ZIP and extract it.
2. Open `chrome://extensions` in Chrome or `brave://extensions` in Brave.
3. Enable Developer mode, select Load unpacked, and select the folder containing `manifest.json`.
4. Disable any previous Google Images Restored installation to avoid duplicate panels, then refresh Google Images.

## Privacy and permissions

Settings use browser sync storage. The extension does not send browsing activity to an analytics service. Image copying downloads the selected image through the background worker; images may be hosted on any website, which requires broad host permission. Clipboard access is used when you click Copy image or Copy photo URL. Image hosts may refuse downloads, and Google's changing markup can affect image extraction.

## License and provenance

MIT licensed. This release contains the replacement viewer, popup and clipboard worker developed for this project. It excludes the older Google Images Restored implementation, its restricted license and its original artwork. The new icon was generated from a rainbow origami reference. Google is a trademark of Google LLC; this project is independent and is not endorsed by Google.

© Shubham Singh 2026

## Development

No build step or dependencies are required. With Node.js installed, run `npm test` for image mapping, clipboard transport, preloading, selected-image focus, collage resizing and automatic orientation checks. These checks do not replace testing the unpacked extension in a browser.

Choose a default orientation in the popup (vertical for new installs). Automatic orientation uses vertical for images at least 40% taller than wide, horizontal for images at least 40% wider than tall, and your default for other shapes. It updates on clicks, preview buttons, and keyboard navigation using the loaded image dimensions.
