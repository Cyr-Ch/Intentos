.PHONY: install test evaluate prevent recover learn

install:
	python3 -m venv .venv
	.venv/bin/python -m pip install -e '.[test]'

test:
	.venv/bin/python -m pytest -q

evaluate:
	.venv/bin/python eval/compare.py --repeats 3

prevent:
	./demo/run_demo.sh prevent ../mergeguard-prevent-$$(date +%Y%m%d-%H%M%S)

recover:
	./demo/run_demo.sh recover ../mergeguard-recover-$$(date +%Y%m%d-%H%M%S)

learn:
	./demo/run_demo.sh learn ../mergeguard-learn-$$(date +%Y%m%d-%H%M%S)
