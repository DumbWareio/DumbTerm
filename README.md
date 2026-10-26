# DumbTerm

A stupidly simple web-based terminal emulator, with common tools and Starship enabled! 🚀

![dumbterm-preview](https://github.com/user-attachments/assets/45a4542f-7f69-4dcd-a6df-39e5231e3db2)

- Access your terminal from any device with a web browser
- Execute commands just like in a native terminal
- Starship prompt provides a beautiful terminal experience with git status, command duration, etc.
- PIN protection (recommended) prevents unauthorized access
- Use the data directory to persist files between container restarts
- Demo mode available for testing and demonstrations - simulated terminal (set DEMO_MODE=true)

## Use cases:

- Build with docker: To create a sandboxed environment for testing scripts, code, applications, emulate a VPS, showcase examples and more. All without having to install dependencies on your local machine!
- Build locally: To access your client's cli/terminal through your browser instead!
- Self-hosting: Put behind a reverse proxy, auth provider (like authentik, authelia, etc), Cloudflare tunnels with application access rules, etc for secure external access.
- Another alternative to web terminals such as ttyd, shellinabox, etc

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
  - [Prerequisites](#prerequisites)
  - [Option 1: Docker (For Dummies)](#option-1-docker-for-dummies)
  - [Option 2: Docker Compose (Recommended)](#option-2-docker-compose-for-dummies-who-like-customizing---recommended)
  - [Option 3: Running Locally](#option-3-running-locally-for-developers)
    - [Windows-specific](#windows-specific)
- [Configuration](#configuration)
  - [Environment Variables](#environment-variables)
  - [Starship usage](#starship-usage)
    - [Starship Presets](#starship-presets)
- [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Terminal Search](#terminal-search)
  - [Tab Management](#tab-management)
- [Security](#security)
  - [Features](#features-1)
- [Technical Details](#technical-details)
  - [Stack](#stack)
  - [Dependencies](#dependencies)
  - [Supported XTerm Addons](#supported-xterm-addons)
- [Links](#links)
- [Contributing](#contributing)
- [Check Us Out](#-check-us-out)
- [Future Features](#future-features)

## Features

- 🖥️ Web-based terminal access from anywhere
- 🌙 Dark mode support
- 📱 Responsive design for mobile and desktop
- 🐳 Docker support (Debian-based container)
- 🔧 Pre-installed utilities: starship, nerdfonts, apt-utils, curl, wget, ssh, git, vim, nano, htop, net-tools, iputils-ping, traceroute, fontconfig, unzip, locales, python3, etc.
- 🔒 Optional PIN protection (numeric)
- ✨ Starship prompt integration for beautiful terminal experience
- 🔍 Terminal search functionality (`ctrl+f` or `cmd+f`)
- 📂 Custom volume mappings
- 🔗 In-terminal hyperlinks
- ⌨️ Keyboard shortcuts for common actions
- 📑 Tab Management:
  - Drag and drop reordering of tabs
  - Double-click to rename tabs
  - Direct tab selection with shortcuts
  - Terminal history persistence across sessions
- 📱 PWA Support for mobile and desktop
- ⚡ XTerm.js for fast terminal rendering

## Quick Start

### Prerequisites

- Docker (recommended)
- Node.js >=24 (for local development)
  - _Windows-specific_: see [Option 3: Running Locally](#option-3-running-locally-for-developers)

### Option 1: Docker (For Dummies)

- Docker method uses a pre-installed Debian 13 Trixie-based container/environment.

```bash
# Pull and run with one command
docker run -p 3000:3000 \
  -v ./data:/root/data \
  -v ./config:/root/.config \
  -e DUMBTERM_PIN=1234 \
  -e SITE_TITLE=DumbTerm \
  -e BASE_URL=http://localhost:3000 \
  -e ALLOWED_ORIGINS=http://localhost:3000 \
  -e ENABLE_STARSHIP=true \
  -e TZ=America/Los_Angeles \
  -e LOCKOUT_TIME=15 \
  -e MAX_SESSION_AGE=24 \
  dumbwareio/dumbterm:latest
```

1. Go to http://localhost:3000
2. Enter your PIN if configured
3. Enjoy your web-based terminal!

### Option 2: Docker Compose (For Dummies who like customizing) - Recommended

Create a `docker-compose.yml` file or use the provided one:

```yaml
services:
  dumbterm:
    image: dumbwareio/dumbterm:latest
    container_name: dumbterm
    restart: unless-stopped
    ports:
      - ${DUMBTERM_PORT:-3000}:3000
    volumes:
      - ${DUMBTERM_CONFIG:-./config}:/root/.config
      - ${DUMBTERM_DATA_DIR:-./data}:/root/data
    environment:
      # Container timezone
      TZ: ${DUMBTERM_TZ:-America/Los_Angeles}
      # The title shown in the web interface
      SITE_TITLE: ${DUMBTERM_SITE_TITLE:-DumbTerm}
      # Recommended PIN protection (leave empty to disable)
      DUMBTERM_PIN: ${DUMBTERM_PIN:-1234}
      # The base URL for the application
      BASE_URL: ${DUMBTERM_BASE_URL:-http://localhost:3000}
      ENABLE_STARSHIP: ${ENABLE_STARSHIP:-true}
      LOCKOUT_TIME: ${DUMBTERM_LOCKOUT_TIME:-15} # Minutes
      # Session duration in hours before requiring re-authentication
      MAX_SESSION_AGE: ${DUMBTERM_MAX_SESSION_AGE:-24} # Hours
      # (OPTIONAL) - List of allowed origins for CORS
      # ALLOWED_ORIGINS: ${DUMBTERM_ALLOWED_ORIGINS:-http://localhost:3000}
```

Then run:

```bash
docker compose up -d
```

To update to the latest version later, run `docker compose pull && docker compose up -d`.

### Option 3: Running Locally (For Developers)

- Local method will use your local terminal environment (Windows: Powershell, Mac / Linux: bash).

1. Install dependencies:

```bash
npm install
```

> [!TIP]
>
> #### Windows specific:
>
> - `node-pty` ships prebuilt Windows binaries (x64 and arm64), so build tools are normally not needed.
> - If you still encounter issues with `node-pty` you can try using [Windows Subsystem for Linux (WSL)](https://learn.microsoft.com/en-us/windows/wsl/install) or install:
> - `windows-build-tools` through Visual Studio Installer `MSVC v142 - VS 2019 C++ {arch} Build Tools`
>   - Contact us or View the [official Microsoft documentation](https://github.com/microsoft/node-pty?tab=readme-ov-file#windows) for more details

2. `cp .env.example .env` > Set environment variables in `.env`:

```bash
PORT=3000                  # Port to run the server on
DUMBTERM_PIN=1234          # Optional PIN protection
SITE_TITLE=DumbTerm        # Custom site title
BASE_URL=http://localhost:3000  # Base URL for the application
```

3. Start the server:

```bash
npm start
```

4. (Optional) Run the test suite:

```bash
npm test
```

## Configuration

### Environment Variables

| Variable        | Description                                       | Default               | Required |
| --------------- | ------------------------------------------------- | --------------------- | -------- |
| PORT            | Server port                                       | 3000                  | No       |
| BASE_URL        | Base URL for the application                      | http://localhost:PORT | No       |
| DUMBTERM_PIN    | PIN protection (numeric)                          | None                  | No       |
| SITE_TITLE      | Site title displayed in header                    | DumbTerm              | No       |
| TZ              | Container timezone                                | America/Los_Angeles   | No       |
| ENABLE_STARSHIP | Enable Starship prompt (docker only)              | true                  | No       |
| NODE_ENV        | Node environment mode (development or production) | production            | No       |
| ALLOWED_ORIGINS | Allowed CORS origins (comma-separated list)       | \* (all origins)      | No       |
| DEBUG           | Enable debug logging                              | FALSE                 | No       |
| LOCKOUT_TIME    | Custom Pin Lockout Time (in minutes)              | 15                    | No       |
| MAX_SESSION_AGE | Duration of authenticated session (in hours)      | 24                    | No       |
| DEMO_MODE       | Enable demo mode with simulated terminal          | false                 | No       |

### Starship usage

- Starship is a cross-shell prompt that provides a beautiful terminal experience.
- It is enabled by default in the Docker image and is the recommended method.
- To disable it, set `ENABLE_STARSHIP` to `false` in your environment variables.
- You can customize the Starship prompt by using one of the following steps:

### 1. Use a preset configuration from starship.

#### Starship Presets:

> [!TIP]
> copy and paste one of the starship preset commands below into DumbTerm and that's it!

<details>
<summary><b>Example Preset Command:</b></summary>

![preset-preview](https://github.com/user-attachments/assets/affdd780-5471-40de-adfd-9242feeec9da)

</details>

<br/>

> [!WARNING] > **Note:** If running locally or mapped volume to your actual `starship.toml` config, the preset commands will overwrite your existing `starship.toml` file. Make sure to back it up as needed.

<details>
<summary><b>View All Starship Presets:</b></summary>

| Preset Name                                | Command                                                          | Preview                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Nerd Font Symbols                          | `starship preset nerd-font-symbols -o ~/.config/starship.toml`   | ![Nerd Font Symbols](https://starship.rs/presets/img/nerd-font-symbols.png)     |
| Bracketed Segments                         | `starship preset bracketed-segments -o ~/.config/starship.toml`  | ![Bracketed Segments](https://starship.rs/presets/img/bracketed-segments.png)   |
| Plain Text Symbols                         | `starship preset plain-text-symbols -o ~/.config/starship.toml`  | ![Plain Text Symbols](https://starship.rs/presets/img/plain-text-symbols.png)   |
| No Runtime Versions                        | `starship preset no-runtime-versions -o ~/.config/starship.toml` | ![No Runtime Versions](https://starship.rs/presets/img/no-runtime-versions.png) |
| No Empty Icons                             | `starship preset no-empty-icons -o ~/.config/starship.toml`      | ![No Empty Icons](https://starship.rs/presets/img/no-empty-icons.png)           |
| Pure Prompt                                | `starship preset pure-preset -o ~/.config/starship.toml`         | ![Pure Prompt](https://starship.rs/presets/img/pure-preset.png)                 |
| Pastel Powerline                           | `starship preset pastel-powerline -o ~/.config/starship.toml`    | ![Pastel Powerline](https://starship.rs/presets/img/pastel-powerline.png)       |
| Tokyo Night `(DumbTerm Default with mods)` | `starship preset tokyo-night -o ~/.config/starship.toml`         | ![Tokyo Night](https://starship.rs/presets/img/tokyo-night.png)                 |
| Gruvbox Rainbow                            | `starship preset gruvbox-rainbow -o ~/.config/starship.toml`     | ![Gruvbox Rainbow](https://starship.rs/presets/img/gruvbox-rainbow.png)         |
| Jetpack                                    | `starship preset jetpack -o ~/.config/starship.toml`             | ![Jetpack](https://starship.rs/presets/img/jetpack.png)                         |
| No Nerd Fonts                              | `starship preset no-nerd-font -o ~/.config/starship.toml`        | n/a                                                                             |

</details>

- You can also view the available presets by running `starship preset -l` in DumbTerm.

For more details, visit the [Starship Presets page](https://starship.rs/presets/).

### 2. Modify the `~/.config/starship.toml` file in your set volume mount or within the container.

- The default configuration is located in `/root/.config/starship.toml`.
- You can also mount a custom `starship.toml` file to the container using Docker volumes.
- Update or add your custom configurations to starship.toml.
  - Visit [Starship Configuration](https://starship.rs/config/) for more information on customizing the prompt.

### 3. Running locally

- If you are running DumbTerm locally, DumbTerm will inherit your current styles.
  - Meaning if you already have starship enabled locally, you should be able to see your current styles accordingly.
- You must install Starship on your local machine if you wish to use DumbTerm with starship _locally_.
  - To install Starship, follow the instructions on the [Starship installation page](https://starship.rs/installing/).

## Keyboard Shortcuts

DumbTerm provides a comprehensive set of keyboard shortcuts for efficient terminal management. The modifier keys vary by operating system:

- Windows/Linux: `Ctrl+Alt+{key}`
- macOS: `Ctrl+Cmd+{key}`

| Action                 | Windows/Linux                | macOS                        |
| ---------------------- | ---------------------------- | ---------------------------- |
| New Terminal           | `Ctrl+Alt+T`                 | `Ctrl+Cmd+T`                 |
| Close Terminal         | `Ctrl+Alt+W`                 | `Ctrl+Cmd+W`                 |
| Rename Terminal        | `Ctrl+Alt+R`                 | `Ctrl+Cmd+R`                 |
| Search in Terminal     | `Ctrl+F`                     | `Cmd+F`                      |
| Next Terminal          | `Ctrl+Alt+>` or `Ctrl+Alt+.` | `Ctrl+Cmd+>` or `Ctrl+Cmd+.` |
| Previous Terminal      | `Ctrl+Alt+<` or `Ctrl+Alt+,` | `Ctrl+Cmd+<` or `Ctrl+Cmd+,` |
| Switch to Terminal 1-9 | `Ctrl+Alt+[1-9]`             | `Ctrl+Cmd+[1-9]`             |

### Terminal Search

- Press `Ctrl+F` (Windows/Linux) or `Cmd+F` (macOS) to open the search bar
- Use Up/Down arrow buttons or Enter/Shift+Enter to cycle through matches
- Press Escape or the close button to exit search mode

### Tab Management

- **Drag and Drop**: Click and drag tabs to reorder them
- **Rename**: Double-click a tab or use the keyboard shortcut to rename it
- **History**: Terminal content is automatically preserved across browser refreshes and restarts
- **Direct Selection**: Use number shortcuts (1-9) to quickly switch between the first 9 terminals

## Security

> It is highly recommended to set a strong PIN, use HTTPS, use ALLOWED_ORIGINS, and integrate with an auth provider (i.e. Authentik / Authelia / tinyauth, etc).

We're dumb, but not stupid. Use a full-featured auth provider for production use.

- https://github.com/goauthentik/authentik (More difficult to set up, but production ready)
- https://github.com/authelia/authelia
- https://github.com/steveiliop56/tinyauth (Easy with docker compose integration)

### Features

- Variable-length PIN support (numeric)
- Constant-time PIN comparison
- Brute force protection:
  - 5 attempts maximum
  - 15-minute lockout after failed attempts
  - IP-based tracking
- Secure cookie handling
- Session-based authentication
- CORS support for origin restrictions (optional)
- HTTPS support (when configured with proper BASE_URL)

## Technical Details

### Stack

- **Backend**: Node.js (>=24) with Express
- **Frontend**: XTerm.js for terminal emulation
- **Container**: Docker with Debian Trixie (as of v1.2.1+) base (v1.1.1 for Bullseye)
- **Terminal**: node-pty for process spawning
- **Communication**: WebSockets for real-time terminal I/O
- **Security**: cors for cross-origin requests
<!-- * **Security**: Helmet for HTTP security headers -->

### Dependencies

- express: Web framework
- node-pty: Terminal process spawning
- xterm: Terminal frontend
- ws: WebSocket server
- cookie-parser: Cookie handling
- express-session: Session management
- cors: security for cross-origin requests
<!-- * helmet: Security middleware -->

### Supported XTerm Addons

DumbTerm includes the following XTerm.js addons to enhance your terminal experience:

| Addon                      | Description                                                                       |
| -------------------------- | --------------------------------------------------------------------------------- |
| **@xterm/addon-attach**    | Attaches a terminal session to a websocket                                        |
| **@xterm/addon-canvas**    | Renderer that uses canvas to draw terminal content (used as fallback after webgl) |
| **@xterm/addon-clipboard** | Clipboard integration for copy/paste support                                      |
| **@xterm/addon-fit**       | Automatically resize terminal to fit its container                                |
| **@xterm/addon-image**     | Display images inline in the terminal                                             |
| **@xterm/addon-ligatures** | Font ligatures support                                                            |
| **@xterm/addon-search**    | Search text in the terminal buffer                                                |
| **@xterm/addon-serialize** | Serialize terminal output to string or HTML                                       |
| **@xterm/addon-unicode11** | Additional Unicode 11 character width support                                     |
| **@xterm/addon-web-links** | Automatically hyperlink URLs in terminal                                          |
| **@xterm/addon-webgl**     | Renderer that uses WebGL for better performance (default render method)           |

## Links

- GitHub: [github.com/dumbwareio/dumbterm](https://github.com/dumbwareio/dumbterm)
- Docker Hub: [hub.docker.com/r/dumbwareio/dumbterm](https://hub.docker.com/r/dumbwareio/dumbterm)

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes using conventional commits
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

See Development Guide for local setup and guidelines.

---

Made with ❤️ by [DumbWareio](https://github.com/dumbwareio) & [gitmotion](https://github.com/gitmotion)

## 🌐 Check Us Out

- **Website:** [dumbware.io](https://www.dumbware.io/)
- **Join the Chaos:** [Discord](https://discord.gg/zJutzxWyq2) 💬

## Support the Project

<a href="https://www.buymeacoffee.com/dumbware" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="60">
</a>

## Future Features

- Additional authentication methods

> Got an idea? Open an issue or submit a PR
