IVE for Mac

Install
1. Drag IVE into Applications.
2. Open IVE from Applications. It starts its own local service in the
   background; no terminal window is needed.
3. Follow the setup and connect a project.

Requirements
A Mac with Apple silicon (M1 or newer) and macOS 13.5 or newer.
At least one coding CLI installed and logged in: Claude Code, Codex or
Gemini CLI.

The app is signed with a Developer ID of AIFOREU GmbH and notarized by Apple.

Your data
Projects and settings live in ~/Library/Application Support/com.ive.desktop.
IVE only listens on 127.0.0.1:5112. Cmd+Q quits the app and its service.

Uninstall
While it runs, IVE adds hooks to the settings of your coding CLIs. Quit IVE,
then remove them in Terminal:

  "/Applications/IVE.app/Contents/Resources/backend/ive-backend" --remove-hooks

Then drag IVE to the Trash.

Source code, issues and license (Apache 2.0): https://github.com/michael-ra/ive
