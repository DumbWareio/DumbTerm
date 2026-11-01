const { EventEmitter } = require('events');

class DemoTerminal extends EventEmitter {
    constructor(options = {}) {
        super();
        this.cols = options.cols || 80;
        this.rows = options.rows || 24;
        this.currentDirectory = '/home/demo';
        this.commandBuffer = '';
        this.pid = Math.floor(Math.random() * 10000); // Fake PID
        this.username = 'demo';
        this.hostname = 'dumbterm';
        this.osInfo = {
            sysname: 'Linux',
            release: '5.10.0',
            version: 'Demo',
            machine: 'x86_64'
        };

        // Basic file system simulation
        this.fileSystem = {
            '/': { type: 'dir', contents: ['home', 'usr', 'etc'] },
            '/home': { type: 'dir', contents: ['demo'] },
            '/home/demo': { type: 'dir', contents: ['Documents', 'Downloads', '.bashrc'] },
            '/home/demo/Documents': { type: 'dir', contents: ['readme.txt'] },
            '/home/demo/Downloads': { type: 'dir', contents: [] },
            '/home/demo/Documents/readme.txt': { type: 'file', contents: 'Welcome to DumbTerm Demo Mode!\nThis is a simulated terminal environment.\n' },
            '/usr': { type: 'dir', contents: ['bin', 'local'] },
            '/usr/bin': { type: 'dir', contents: ['ls', 'cd', 'pwd', 'cat', 'echo', 'whoami', 'hostname', 'uname', 'date'] },
            '/etc': { type: 'dir', contents: ['passwd', 'hosts'] }
        };

        // Emit initial prompt
        setImmediate(() => {
            this.emit('data', 'demo@dumbterm:' + this.currentDirectory + '$ ');
        });
    }

    write(data) {
        // Only typed text: the demo runs no program that turns mouse reports on, which come as bytes
        if (typeof data !== 'string') {
            return;
        }
        // Handle terminal input
        if (data === '\r') {
            // Process command when Enter is pressed
            this.processCommand(this.commandBuffer.trim());
            this.commandBuffer = '';
        } else if (data === '\u007f') {
            // Handle backspace
            this.commandBuffer = this.commandBuffer.slice(0, -1);
            this.emit('data', '\b \b'); // Move back, clear character, move back
        } else {
            // Echo character and add to buffer
            this.commandBuffer += data;
            this.emit('data', data);
        }
    }

    resize(cols, rows) {
        this.cols = cols;
        this.rows = rows;
    }

    kill() {
        this.emit('exit', 0);
    }

    processCommand(command) {
        this.emit('data', '\r\n'); // New line after command

        if (!command) {
            this.emit('data', 'demo@dumbterm:' + this.currentDirectory + '$ ');
            return;
        }

        const parts = command.split(' ');
        const cmd = parts[0];
        const args = parts.slice(1);

        switch (cmd) {
            case 'ls':
                this.handleLs(args);
                break;
            case 'cd':
                this.handleCd(args[0]);
                break;
            case 'pwd':
                this.handlePwd();
                break;
            case 'whoami':
                this.handleWhoami();
                break;
            case 'hostname':
                this.handleHostname();
                break;
            case 'uname':
                this.handleUname(args);
                break;
            case 'date':
                this.handleDate();
                break;
            case 'cat':
                this.handleCat(args[0]);
                break;
            case 'echo':
                this.handleEcho(args);
                break;
            case 'help':
                this.handleHelp();
                break;
            case 'clear':
                this.handleClear();
                break;
            default:
                if (cmd.startsWith('./')) {
                    this.emit('data', `bash: ${cmd}: Permission denied\r\n`);
                } else {
                    this.emit('data', `${cmd}: command not found\r\n`);
                }
        }

        this.emit('data', 'demo@dumbterm:' + this.currentDirectory + '$ ');
    }

    handleLs(args) {
        const path = args[0] || this.currentDirectory;
        const absolutePath = this.resolveAbsolutePath(path);
        
        if (!this.fileSystem[absolutePath]) {
            this.emit('data', `ls: cannot access '${path}': No such file or directory\r\n`);
            return;
        }

        if (this.fileSystem[absolutePath].type !== 'dir') {
            this.emit('data', `${path}\r\n`);
            return;
        }

        const contents = this.fileSystem[absolutePath].contents;
        this.emit('data', contents.join('  ') + '\r\n');
    }

    handleCd(path) {
        if (!path || path === '~') {
            this.currentDirectory = '/home/demo';
            return;
        }

        // Handle '..' for moving up directories
        if (path === '..' || path.startsWith('../')) {
            const levels = path.split('/').filter(p => p === '..').length;
            let newPath = this.currentDirectory;
            
            for (let i = 0; i < levels; i++) {
                // Don't go up if we're already at root
                if (newPath === '/') break;
                newPath = newPath.split('/').slice(0, -1).join('/') || '/';
            }
            
            this.currentDirectory = newPath;
            return;
        }

        const absolutePath = this.resolveAbsolutePath(path);
        
        if (!this.fileSystem[absolutePath]) {
            this.emit('data', `cd: no such directory: ${path}\r\n`);
            return;
        }

        if (this.fileSystem[absolutePath].type !== 'dir') {
            this.emit('data', `cd: not a directory: ${path}\r\n`);
            return;
        }

        this.currentDirectory = absolutePath;
    }

    handlePwd() {
        this.emit('data', this.currentDirectory + '\r\n');
    }

    handleCat(path) {
        if (!path) {
            this.emit('data', 'cat: missing operand\r\n');
            return;
        }

        const absolutePath = this.resolveAbsolutePath(path);
        
        if (!this.fileSystem[absolutePath]) {
            this.emit('data', `cat: ${path}: No such file or directory\r\n`);
            return;
        }

        if (this.fileSystem[absolutePath].type !== 'file') {
            this.emit('data', `cat: ${path}: Is a directory\r\n`);
            return;
        }

        this.emit('data', this.fileSystem[absolutePath].contents + '\r\n');
    }

    handleEcho(args) {
        this.emit('data', args.join(' ') + '\r\n');
    }

    handleWhoami() {
        this.emit('data', this.username + '\r\n');
    }

    handleHostname() {
        this.emit('data', this.hostname + '\r\n');
    }

    handleUname(args) {
        if (args.includes('-a') || args.includes('--all')) {
            this.emit('data', `${this.osInfo.sysname} ${this.hostname} ${this.osInfo.release} ${this.osInfo.version} ${this.osInfo.machine}\r\n`);
        } else if (args.includes('-s') || args.includes('--kernel-name')) {
            this.emit('data', this.osInfo.sysname + '\r\n');
        } else if (args.includes('-r') || args.includes('--kernel-release')) {
            this.emit('data', this.osInfo.release + '\r\n');
        } else if (args.includes('-m') || args.includes('--machine')) {
            this.emit('data', this.osInfo.machine + '\r\n');
        } else {
            this.emit('data', this.osInfo.sysname + '\r\n');
        }
    }

    handleDate() {
        const date = new Date();
        this.emit('data', date.toString() + '\r\n');
    }

    handleHelp() {
        this.emit('data', 
            'Available commands:\r\n' +
            '  ls        - List directory contents\r\n' +
            '  cd        - Change directory\r\n' +
            '  pwd       - Print working directory\r\n' +
            '  whoami    - Print current user name\r\n' +
            '  hostname  - Show system hostname\r\n' +
            '  uname     - Print system information\r\n' +
            '  date      - Display current time and date\r\n' +
            '  cat       - Display file contents\r\n' +
            '  echo      - Display a message\r\n' +
            '  clear     - Clear the terminal screen\r\n' +
            '  help      - Show this help message\r\n'
        );
    }

    handleClear() {
        this.emit('data', '\x1b[2J\x1b[H');
    }

    resolveAbsolutePath(path) {
        if (!path) return this.currentDirectory;
        if (path.startsWith('/')) return path;
        return this.currentDirectory + '/' + path;
    }
}

module.exports = {
    spawn: (file, args = [], options = {}) => {
        return new DemoTerminal(options);
    }
};