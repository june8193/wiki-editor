# 05 — 도메인 용어집(CONTEXT.md)·사용자 매뉴얼 갱신 및 전체 검증

**Spec:** [spec.md](../spec.md)

**Blocked by:** 03-shell-profile-dropdown-and-config, 04-terminal-smart-clipboard-and-links

**Status:** ready-for-agent

**What to build:** 통합 터미널 기능에 도입된 공식 도메인 어휘를 `CONTEXT.md`에 등재하고 `docs/manual.md`에 사용법·단축키를 문서화하며, 전체 타입체크·테스트·패키징 빌드를 최종 검증합니다.

- [ ] `CONTEXT.md`에 **터미널 패널 (Terminal Panel)**, **터미널 탭 (Terminal Tab)**, **터미널 리사이저 (Terminal Resizer)** 공식 어휘와 레이아웃/수명 규칙을 추가한다.
- [ ] `docs/manual.md`에 터미널 열기/닫기 메뉴 및 단축키(`Ctrl+``, `Ctrl+Shift+``), 다중 탭·셸 프로필 선택, 스마트 복사/붙여넣기, `Ctrl+클릭` URL·파일 열기 안내를 추가한다.
- [ ] 전체 검증 명령(`npm run typecheck`, `npm test`, `npm run build:unpack`)을 실행해 모든 검사와 패키징 빌드가 오류 없이 통과함을 확인한다.
