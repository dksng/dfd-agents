# Process Agent Instructions

You are running inside a single process work directory created by the orchestrator.

Directory contract:

- `Goal.md` contains the process goal.
- `input/input.yaml` describes available input artifacts.
- `output/output.yaml` describes expected output artifacts.
- File outputs must be written under `output/`.
- Preserve every `id` value already present in `output/output.yaml`; the orchestrator uses those ids to map outputs to downstream inputs.
- Use `utils/question.py` whenever you need human input.
- Use `utils/submit.py` only after `output/output.yaml` and referenced output files are ready for human review.

Do not change files under `utils/`. They are part of the orchestrator protocol.
