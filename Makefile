.PHONY: lint format test build verify

lint:
	python3 -m ruff check agent_orchestrator tests scripts
	python3 -m ruff format --check agent_orchestrator tests scripts
	npm --prefix frontend run lint
	npm --prefix frontend run format:check

format:
	python3 -m ruff format agent_orchestrator tests scripts
	python3 -m ruff check --fix agent_orchestrator tests scripts
	npm --prefix frontend run format
	npm --prefix frontend run lint:fix

test:
	python3 -m pytest

build:
	npm --prefix frontend run build

verify: lint test build
