.PHONY: install verify test typecheck demo report gen db-up db-down psql clean

install:
	npm ci

verify: typecheck test

typecheck:
	npm run typecheck

test:
	npm test

demo:
	npm run demo

report:
	npm run report

# Regenerate the SQL module embedded in the browser demo.
gen:
	node scripts/gen-sql.mjs

# Optional: a real Postgres with pgvector, for running the SQL outside the
# in-process harness. Not required for `make verify`.
db-up:
	docker compose up -d postgres
	@echo "waiting for postgres..."
	@for i in $$(seq 1 30); do \
		docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1 && break; \
		sleep 1; \
	done
	@echo "postgres ready on localhost:5432"

db-migrate:
	docker compose exec -T postgres psql -U postgres -d ai_employees -f /schema/schema.sql
	docker compose exec -T postgres psql -U postgres -d ai_employees -f /schema/policies.sql

db-down:
	docker compose down -v

psql:
	docker compose exec postgres psql -U postgres -d ai_employees

clean:
	rm -rf node_modules coverage
