# Contributing

Thanks for your interest in contributing to this project.

## How to contribute

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Submit a pull request

## Guidelines

- Keep changes focused -- one concern per pull request
- Follow the existing file structure and naming conventions
- Run `claude plugin validate .` and `claude plugin test` before submitting, and add tests for new behavior
- Load the mod in Claude Code once (`claude --plugin-dir .`) before type-checking: `tsconfig.json` extends the types Claude Code writes to `.claude-plugin/types/`
- Keep `hooks/salesforce.ts` identical to the copy in sf-headless-config -- change both together

## Reporting issues

Open a GitHub issue with a clear description of the problem or suggestion.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
