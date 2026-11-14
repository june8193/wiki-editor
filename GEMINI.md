# wiki-editor 에이전트 규칙 (GEMINI.md)

## TDD (Test Driven Development) 규칙

- **개발 절차 (Red-Green-Refactor)**:
  1. **Red**: 구현 전 실패하는 테스트를 먼저 작성합니다.
  2. **Green**: 테스트를 통과하는 최소한의 코드를 작성합니다.
  3. **Refactor**: 테스트 통과 상태를 유지하며 코드를 개선(리팩토링)합니다.
- **검증 원칙**: 기능 추가나 버그 수정 완료 시 관련 테스트를 실행해 모두 통과하는지 확인합니다.
- **테스트 격리**: 테스트는 반드시 격리된 환경(임시 디렉토리, 인메모리 등)에서 수행하며, 실제 데이터나 작업 파일에 영향을 주지 않도록 합니다.

## Agent skills

### Issue tracker

Local markdown under `.backlog/<feature-slug>/` (archived to `.backlog/done/<feature-slug>/` when all tickets are completed). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.
