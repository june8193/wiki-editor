# 01 — Electron + React + TS 스캐폴딩, 전역 설정(config.json) 및 라이트/다크 테마

Spec: [spec.md](../spec.md)
Type: task
Blocked by: None — can start immediately
Status: ready-for-agent

**What to build:**
Windows 데스크톱용 `Electron + React + TypeScript` (`electron-vite` + `Vitest`) 프로젝트 골격을 구축하고, 단일 전역 설정 파일(`config.json`) 로드/저장 서비스와 IPC 브릿지(`window.wikiApi`), 그리고 설정과 연동되어 즉시 전환·영속화되는 라이트/다크 테마 UI 셸을 완성합니다.

## Acceptance Criteria

- [ ] `electron-vite` + React 19 + TypeScript + Vitest(Node 및 jsdom/React Testing Library) 프로젝트 구조와 `npm test`, `npm run typecheck`, `npm run build` 스크립트가 동작합니다.
- [ ] `contextIsolation: true`, `nodeIntegration: false` 보안 설정으로 Electron 메인 윈도우가 실행되며, `preload`의 `contextBridge`를 통해 타입 안전한 `window.wikiApi.config` API(`get`, `update`, `getConfigPath`, `onChanged`)가 노출됩니다.
- [ ] `ConfigService`는 주입 가능한 설정 경로(실행 시 `app.getPath('userData')/config.json`, 테스트 시 `fs.mkdtemp` 임시 디렉토리)를 사용해 최초 실행 시 기본 `AppConfig`로 `config.json`을 생성하고, 손상된 JSON 복구 및 부분 업데이트 시 원자적 저장(Atomic write)을 수행합니다.
- [ ] UI 헤더/설정 패널에 라이트/다크 테마 토글이 제공되며, 전환 시 CSS Variables(`data-theme="light" | "dark"`)가 즉시 반영되고 앱 재시작 후에도 `config.json`의 설정이 유지됩니다.
- [ ] 설정 패널에서 `config.json` 파일 경로 확인 및 "설정 파일 직접 열기" 준비(경로 반환/읽기)가 가능하고, 모든 테스트는 실제 OS `userData`를 건드리지 않는 격리된 임시 디렉토리에서 TDD로 작성·통과합니다.
