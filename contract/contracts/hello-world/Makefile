# Default target
default: build

all: test

# Build and test
test: build
	cargo test

build:
	stellar contract build
	@ls -l target/wasm32v1-none/release/*.wasm
	@ls -l target/wasm32-unknown-unknown/release/*.wasm 2>/dev/null || true

fmt:
	cargo fmt --all

clean:
	cargo clean

# Deployment
# -------------------------------------------

# Optional .env file for local configuration
#ifneq ($,wildcard .env)
include .env
export
endif

# Network selection
# Use `make deploy-testnet` or `make deploy-mainnet` to select an explicit network.
# Default contract wasm
CONTRACT_WASM ?= target/wasm32v1-none/release/hello_world.wasm

# Path to where the deployment manifest will be written (safe to commit).
MANIFEST_FILE ?= deployment-manifest.json

# Manifest schema version. Increment when manifest format changes.
MANIFEST_SCHEMA_VERSION := 1

deploy-testnet:
	$(MAKE) deploy RPC_URL=https://soroban-testnet.stellar.org NETWORK_PASSPHRASE="Test SDF Network ; September 2015" NETWORK_NAME=testnet

deploy-mainnet:
	$(MAKE) deploy RPC_URL=https://soroban-mainnet.stellar.org NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015" NETWORK_NAME=mainnet

# Generic deploy target (requires explicit configuration)
deploy: check-deploy-config build
	@echo "Deploying contract to $(NETWORK_NAME)..."
	@deploy_output=$$(stellar contract deploy \
		--wasm $(CONTRACT_WASM) \
		--secret-key "$$DEPLOYER_SECRET_KEY" \
		--rpc-url "$$RPC_URL" \
		--network-passphrase "$$NETWORK_PASSPHRASE" 2>&1); \
	echo "Deployment output:"; \
	echo "$$deploy_output"; \
	contract_id=$$(echo "$$deploy_output" | grep -oE 'C[A-Za-z0-9]{55}' | head -n1); \
	if [ -z "$$contract_id" ]; then \
		echo "Error: Could not extract contract ID from deployment output."; \
		exit 1; \
	fi; \
	echo "Deployed contract ID: $$contract_id"; \
	\
	wasm_sha256=""; \
	if command -v sha256sum >/dev/null 2>&1; then \
		wasm_sha256=$$(sha256sum "$(CONTRACT_WASM)" | awk '{print $$1}'); \
	elif command -v shasum >/dev/null 2>&1; then \
		wasm_sha256=$$(shasum -a 256 "$(CONTRACT_WASM)" | awk '{print $$1}'); \
	fi; \
	\
	deployed_at_iso=$$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ"); \
	\
	echo "Writing deployment manifest to $(MANIFEST_FILE)"; \
	tmp_manifest=$$(mktemp); \
	{ \
		printf '{\n'; \
		printf '  "manifestVersion": %s,\n' "$(MANIFEST_SCHEMA_VERSION)"; \
		printf '  "contract": {\n'; \
		printf '    "id": "%s",\n' "$$contract_id"; \
		printf '    "wasmPath": "%s",\n' "$(CONTRACT_WASM)"; \
		if [ -n "$$wasm_sha256" ]; then \
			printf '    "wasmSha256": "%s",\n' "$$wasm_sha256"; \
		fi; \
		printf '    "name": "AutoShare"\n'; \
		printf '  },\n'; \
		printf '  "network": {\n'; \
		printf '    "name": "%s",\n' "$(NETWORK_NAME)"; \
		printf '    "rpcUrl": "%s",\n' "$(RPC_URL)"; \
		printf '    "passphrase": "%s"\n' "$(NETWORK_PASSPHRASE)"; \
		printf '  },\n'; \
		printf '  "deployedAt": "%s",\n' "$$deployed_at_iso"; \
		printf '  "deployedBy": "stellar-cli",\n'; \
		printf '  "_securityNote": "This manifest intentionally excludes all private keys, seed phrases, and secret environment variables. Never commit DEPLOYER_SECRET_KEY or any signing material."\n'; \
		printf '}\n'; \
	} > "$$tmp_manifest"; \
	\
	if command -v python3 >/dev/null 2>&1; then \
		python3 -c "import json,sys; json.dump(json.load(open('$$tmp_manifest')),sys.stdout,indent=2,sort_keys=True); print()" > "$(MANIFEST_FILE)"; \
		rm -f "$$tmp_manifest"; \
	elif command -v node >/dev/null 2>&1; then \
		node -e "const fs=require('fs'); const p='$$tmp_manifest'; const d=JSON.parse(fs.readFileSync(p,'utf8')); fs.writeFileSync('$(MANIFEST_FILE)', JSON.stringify(d,null,2)+'\n')"; \
		rm -f "$$tmp_manifest"; \
	else \
		mv "$$tmp_manifest" "$(MANIFEST_FILE)"; \
	fi; \
	\
	echo ""; \
	echo "Manifest written successfully: $(MANIFEST_FILE)"; \
	echo "  Contract ID  : $$contract_id"; \
	echo "  Network     : $(NETWORK_NAME)"; \
	echo "  Deployed at : $$deployed_at_iso"; \
	[ -n "$$wasm_sha256" ] && echo "  WASM SHA256 : $$wasm_sha256" || true

# Validate required deployment configuration
check-deploy-config:
	@if [ -z "$$RPC_URL" ]; then echo "Error: RPC_URL is not set. Set it via environment var or .env file, or use deploy-testnet/deploy-mainnet."; exit 1; fi
	@if [ -z "$$NETWORK_PASSPHRASE" ]; then echo "Error: NETWORK_PASSPHRASE is not set. Use deploy-testnet/deploy-mainnet or set it explicitly."; exit 1; fi
	@if [ -z "$$DEPLOYER_SECRET_KEY" ]; then echo "Error: DEPLOYER_SECRET_KEY is not set. Set it in your environment or .env file."; exit 1; fi
	@test -f $(CONTRACT_WASM) || (echo "Error: Contract WASM not found at $(CONTRACT_WASM). Run 'make build' first."; exit 1)

.PHONY: deploy-testnet deploy-mainnet deploy check-deploy-config
