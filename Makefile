.PHONY: help lint-config lint-config-verbose test-lint-config

help:
	@echo "NotifyChain - Available Commands"
	@echo ""
	@echo "  make lint-config          - Check for unused configuration variables"
	@echo "  make lint-config-verbose  - Check with detailed usage information"
	@echo "  make test-lint-config     - Test the config linter with a mock unused variable"
	@echo ""

lint-config:
	@node scripts/check-unused-config.mjs

lint-config-verbose:
	@VERBOSE=true node scripts/check-unused-config.mjs

# Test the linter by temporarily adding an unused variable
test-lint-config:
	@echo "Testing configuration drift detection..."
	@echo ""
	@echo "# Test unused variable" >> listener/.env.example
	@echo "MOCK_UNUSED_VARIABLE=test" >> listener/.env.example
	@echo "Added MOCK_UNUSED_VARIABLE to listener/.env.example"
	@echo ""
	@node scripts/check-unused-config.mjs || true
	@echo ""
	@echo "Cleaning up test variable..."
	@grep -v "MOCK_UNUSED_VARIABLE" listener/.env.example > listener/.env.example.tmp || true
	@grep -v "Test unused variable" listener/.env.example.tmp > listener/.env.example || true
	@rm -f listener/.env.example.tmp
	@echo "Test complete!"
