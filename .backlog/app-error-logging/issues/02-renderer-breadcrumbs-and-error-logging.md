# 02 — Preload 로그 브리지(window.wikiApi.log) 및 렌더러 UI Breadcrumb·미처리 예외 수집

Spec: [spec.md](../spec.md)
Type: task
Blocked by: 01-main-log-service-and-help-report
Status: ready-for-agent

**What to build:**
`log:write` IPC 핸들러와 Preload `window.wikiApi.log.write` 보안 브리지를 추가하고, Renderer 프로세스의 전역 미처리 예외, **오류 배너** 및 **Git 패널** 오류 표시, **Mermaid 다이어그램 블록** 렌더링 에러, 그리고 주요 UI 동작 Breadcrumb(**탭 바** 조작, **에디터 모드** 전환, **화면 분할 모드** 변경)을 Main `LogService`로 전달하여 `app.jsonl`과 `Help > Copy Bug Report`에 렌더러 동작 흐름까지 통합합니다.

## Acceptance Criteria

- [ ] `log:write` IPC 핸들러와 Preload `window.wikiApi.log.write(payload)`가 `contextIsolation: true` / `nodeIntegration: false` 보안 경계를 유지한 채 렌더러 로그를 `process: 'renderer'`로 `LogService`에 적재하며, `log:write` 호출 자체가 IPC 감사 로그를 중복 생성하지 않습니다.
- [ ] `log:write` 경계 및 렌더러 로깅 호출에서 문서 본문이나 설정 원문 등 민감 텍스트가 기록되지 않고 메타데이터만 전달됩니다.
- [ ] Renderer 전역 미처리 예외(`window.addEventListener('error')`, `window.addEventListener('unhandledrejection')`)가 포착되어 에러 메시지·스택 트레이스와 함께 `LogService`로 전송됩니다.
- [ ] **오류 배너**에 오류가 표시될 때, **Git 패널**에서 Git 오류가 노출될 때, 그리고 **Mermaid 다이어그램 블록** 렌더링에 실패할 때 `error` 또는 `warn` 레벨 로그가 기록됩니다.
- [ ] **탭 바** 탭 열기·닫기·전환·이동·복제, **에디터 모드**(`Raw`·`위지윅`·`Preview`) 전환, **화면 분할 모드**(`single`·`horizontal`·`vertical`) 변경이 `ui` 카테고리 Breadcrumb으로 기록되어 `Help > Copy Bug Report` 타임라인에 시간순으로 포함됩니다.
- [ ] 기존 렌더러 단위/통합 테스트에서 `window.wikiApi.log`가 모킹되지 않은 경우에도 optional/noop 폴백으로 안전하게 동작하며, 신규 TDD 테스트 및 `npm test`, `npm run typecheck`, `npm run build`가 모두 통과합니다.
