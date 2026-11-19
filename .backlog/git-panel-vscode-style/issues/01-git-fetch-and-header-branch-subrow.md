# 01 — `git:fetch` 연동 및 VS Code `"Source Control"` 헤더 · 26px 브랜치 서브행 도입

**Spec:** [spec.md](../spec.md)

**What to build:** `git:fetch` 기능(공유 타입 · Git 서비스 · IPC 핸들러 · Preload 브리지 · Git 컨트롤러)을 엔드투엔드로 연결하고, **Git 패널**의 기존 상단 고정 공통 영역(브랜치 드롭다운 + `전환` 버튼 + `Pull`/`Push`/`Sync` 3열 버튼)을 제거한 뒤 VS Code 스타일의 `"Source Control"` 헤더(새로고침 + `...` 더 보기 메뉴)와 26px 브랜치 서브행(즉시 전환 브랜치 피커 + 우측 `↓N ↑M` / `☁ 미게시` 원격 상태 트리거)으로 전환합니다.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 공유 Git API 계약에 `fetch(workspacePath)`가 추가되고, `git:fetch` IPC 핸들러(발신 세션 활성 워크스페이스 일치 검증) 및 Preload 브리지 매핑이 경계 단위 테스트를 통과합니다.
- [ ] Git 서비스의 `fetch`가 원격 저장소 미설정·비저장소 오류를 기존과 동일하게 처리하고, 격리된 임시 Git 저장소 + 로컬 bare 원격 저장소 통합 테스트에서 워킹 트리를 변경하지 않은 채 원격 참조 및 `behind` 카운트를 최신화함을 검증합니다.
- [ ] **Git 패널** 최상단 헤더가 `"Source Control"` 타이틀과 `lucide-react` 아이콘 버튼(`새로고침`, `...` 더 보기 메뉴: `Pull`, `Push`, `Fetch`, `Sync`, `Stage All Changes`, `Unstage All Changes`, `Discard All Changes`)으로 렌더링되며, 기존 상단 고정 공통 영역이 제거됩니다.
- [ ] 저장소 상태일 때 헤더 아래 26px 브랜치 서브행에 좌측 브랜치 피커(`⎇ <branch>` 또는 Detached 시 `(detached)`)와 우측 원격 상태 트리거(upstream 연결 시 `↓N ↑M` 클릭 → Sync, 미게시 시 `☁ 미게시` 클릭 → Publish/Push, unborn/detached 시 비활성)가 표시됩니다.
- [ ] 브랜치 피커 클릭 시 로컬 브랜치 목록 메뉴가 열려 선택 즉시 브랜치를 전환하고(기존 미저장 **문서 버퍼** 보호 **확인 다이얼로그** 유지), 외부 클릭 또는 `Escape` 키로 닫히며, `...` 메뉴의 `Discard All Changes`는 기존 위험 강조 **확인 다이얼로그**를 거칩니다.
- [ ] 비저장소(`git init`) · 워크스페이스 미열림 상태 UI, 로딩·오류 배너, 바깥 영역 접근성(`aria-label="Git 소스 제어"`), **섹션 리사이저**가 정상 유지되며, `<App />` 통합 테스트와 `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.
