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

What IVE changes
IVE adds hooks to Claude Code, Codex and Gemini CLI so it can follow your
agents and stop risky commands. They stay active, also while IVE is not
running, until you remove them. If you turn on the optional package scanner,
IVE also adds a marked block to ~/.zshrc and ~/.bashrc.

Uninstall
1. Quit IVE (Cmd+Q).
2. In Terminal, remove its hooks and shell block:

   "/Applications/IVE.app/Contents/Resources/backend/ive-backend" --remove-hooks

3. Drag IVE to the Trash.
4. Optional: delete ~/Library/Application Support/com.ive.desktop with your
   IVE settings and history.

If you deleted the app first, IVE's hooks stay inactive and print a short note.
Install IVE again and run step 2, or remove the IVE entries from your coding
CLI settings by hand.

Source code, issues and license (Apache 2.0): https://github.com/michael-ra/ive
