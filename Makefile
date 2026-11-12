# fetch-undici Makefile
# Polyglot HTTP client wrapper for Node.js using Undici

.PHONY: all install build clean test lint format typecheck dev help

# Default target
all: install build

# Install dependencies
install:
	@echo "Installing dependencies..."
	pnpm install

# Build the package
build:
	@echo "Building package..."
	pnpm run build

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	rm -rf dist
	rm -rf node_modules/.cache

# Run tests
test:
	@echo "Running tests..."
	pnpm test

# Run tests with coverage
test-coverage:
	@echo "Running tests with coverage..."
	pnpm run test:coverage

# Run linter
lint:
	@echo "Running linter (Biome)..."
	pnpm run lint

# Fix lint issues
lint-fix:
	@echo "Fixing lint issues..."
	pnpm run lint:fix

# Format code
format:
	@echo "Formatting code..."
	pnpm run format

# Type check
typecheck:
	@echo "Type checking..."
	pnpm run typecheck

# Development mode (watch)
dev:
	@echo "Starting development mode..."
	pnpm run dev

# Full rebuild
rebuild: clean install build

# Pre-commit checks
check: lint typecheck test

# Help
help:
	@echo "fetch-undici Makefile"
	@echo ""
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  all           Install dependencies and build (default)"
	@echo "  install       Install pnpm dependencies"
	@echo "  build         Build the package"
	@echo "  clean         Remove build artifacts"
	@echo "  test          Run tests"
	@echo "  test-coverage Run tests with coverage report"
	@echo "  lint          Run Biome linter"
	@echo "  lint-fix      Fix Biome lint issues"
	@echo "  format        Format code with Prettier"
	@echo "  typecheck     Run TypeScript type checking"
	@echo "  dev           Start development mode (watch)"
	@echo "  rebuild       Clean and rebuild"
	@echo "  check         Run lint, typecheck, and test"
	@echo "  help          Show this help message"
