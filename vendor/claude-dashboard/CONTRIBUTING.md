# Contributing to claude-dashboard

Thank you for your interest in contributing to claude-dashboard!

## Getting Started

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/claude-dashboard.git
   cd claude-dashboard
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development

### Build

```bash
npm run build
```

### Test locally

```bash
echo '{"model":{"display_name":"Opus"},"context_window":{"context_window_size":200000,"current_usage":{"input_tokens":50000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"cost":{"total_cost_usd":0.5}}' | node dist/index.js
```

### Test with Claude Code

```bash
claude --plugin-dir /path/to/claude-dashboard
```

## Pull Request Process

1. Ensure your code builds without errors
2. Test your changes locally with Claude Code
3. Update README.md if you've changed functionality
4. Create a Pull Request with a clear description

## Code Style

- Use TypeScript
- Follow existing code patterns
- Keep functions small and focused
- Add comments for complex logic

## Reporting Issues

- Use GitHub Issues
- Include Claude Code version
- Provide steps to reproduce
- Include error messages if any

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
