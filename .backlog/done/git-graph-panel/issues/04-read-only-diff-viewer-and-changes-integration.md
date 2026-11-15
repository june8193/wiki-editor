# 04 — 중앙 편집 공간 읽기 전용 Diff 탭 도입 및 Changes 섹션 파일 클릭 연동

**Spec:** [spec.md](../spec.md)

**What to build:** Git 서비스의 Staged·Unstaged Diff 조회(`git:diff`)와 Unified Diff 파싱·정렬 모듈, 중앙 **편집 공간**의 읽기 전용 **Diff 탭**을 구현하고, **Changes 섹션**의 `스테이지됨` 및 `변경 사항` 파일을 클릭했을 때 활성 **편집기 영역**에 **Diff 탭**(기본 좌우 비교 Side-by-Side + 인라인 전환 토글 + `파일 열기` 버튼)을 열어 보여줍니다.

**Blocked by:** 01-git-panel-changes-graph-split

**Status:** resolved

- [x] 공유 `GitDiffRequest` / `GitFileDiff` 스키마, `git:diff` IPC 채널(활성 워크스페이스 검증 및 IPC 로그에 패치 원문 미노출 처리 포함), Preload `window.wikiApi.git.diff` 브리지가 연결되고 경계 단위 테스트가 있습니다.
- [x] Git 서비스의 `staged`(`HEAD` 또는 첫 커밋 전 빈 트리 ↔ Index) 및 `unstaged`(추적 파일 Index ↔ Working Tree, 미추적 `?` 파일 전체 추가 `+` 패치 생성) Diff 조회가 이름 변경(`-M`), 바이너리 파일 감지(`isBinary`), 대용량 절단(`1MB`, `isTruncated`), 현재 워크스페이스 내 파일 존재 여부(`existsInWorkspace`), 저장소 밖·`.git` 경로 차단을 격리된 임시 Git 저장소 통합 테스트로 검증합니다.
- [x] Unified Diff 파싱·정렬 순수 모듈이 패치 텍스트로부터 헝크 헤더·양쪽 줄 번호·추가(`+`)/삭제(`-`)/문맥 줄을 추출하고 연속된 삭제·추가 블록을 짝맞춘 좌우 비교(Side-by-Side) 행과 인라인(Unified) 행을 계산하며 단위 테스트가 있습니다.
- [x] **Changes 섹션**에서 파일 항목을 클릭하면 활성 **편집기 영역**에 읽기 전용 **Diff 탭**(파일명 + `Staged` / `Working Tree` 맥락 표시)이 열리며, 같은 행의 `+`/`-`(Stage/Unstage) 버튼을 클릭할 때는 **Diff 탭**이 열리지 않고 스테이징 동작만 수행됩니다.
- [x] **Diff 탭**은 기본 **좌우 비교** 뷰로 렌더링되며 헤더 토글로 **인라인** 뷰와 전환할 수 있고, 바이너리 파일·변경 없음·대용량 절단 안내 상태와 **`파일 열기`** 버튼(`existsInWorkspace === true`일 때 활성화, 클릭 시 해당 워크스페이스 일반 편집 탭 열기/포커스)을 제공합니다.
- [x] 탭 재사용 및 수명주기: 활성 **편집기 영역**에 이미 **Diff 탭**이 있으면 새 파일 클릭 시 그 탭을 교체·포커스하고, 다른 분할 영역으로 이동해 둔 **Diff 탭**은 유지됩니다. **Diff 탭**은 자동 저장·미저장 닫기 **확인 다이얼로그**·`Ctrl+S` 및 에디터 모드 전환 단축키·우측 **문서 목차** 파싱 대상에서 제외되며, 워크스페이스 전환 시 자동으로 닫힙니다.
- [x] Stage, Unstage, Commit, Pull, Sync, 브랜치 전환, 문서 저장, 외부 파일 변경 등으로 Git 상태가 갱신되면 현재 열려 있는 `staged`·`unstaged` **Diff 탭** 내용도 최신 상태로 자동 동기화됩니다.
- [x] `<App />` 통합 테스트가 **Changes 섹션** 파일 클릭 시 **Diff 탭** 열기(`+`/`-` 클릭 분리 포함), 좌우/인라인 전환, `파일 열기` 이동, 활성 영역 **Diff 탭** 교체 재사용 및 분할 영역 유지, Stage/저장 후 Diff 갱신, 워크스페이스 전환 시 닫힘을 검증합니다.
- [x] `CONTEXT.md`에 **Diff 탭**(**Diff 뷰어**) 용어를 추가하고 **편집기 영역**·**탭 바** 설명과 정합성을 맞춥니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.

## Comments

- Commits: `e112a1c`, `109c569`, `5ec3b2a`, `175fa33`, `bb140b0`
- Verification: `npm run typecheck`, `npm test` (`43 passed (43)`, `276 passed (276)`), `npm run build` passed; parallel `/code-review` reached 0 Spec findings and 0 hard Standards violations after 5 iterations (`kind: 'commit'` Speculative Generality heuristic suppressed as mandated by `spec.md` §3 for Ticket 05).
