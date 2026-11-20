# 03 — Stash 인라인 변경 파일 목록, 읽기 전용 Diff 탭 미리보기 및 도메인 용어집 동기화

**Spec:** [spec.md](../spec.md)

**What to build:** `stashDetail` IPC/Preload/GitService 계약(`GitStashDetail`)과 `GitDiffRequest`의 `kind: 'stash'` Diff 산출(추적 변경 `^1 ↔ hash` 및 3번째 부모 `^3`에 보관된 미추적 `?` 새 문서 블롭 읽기, 이름 변경 `-M`, NUL 바이너리 감지, `1MB` 절단 및 `existsInWorkspace` 판별)을 구현합니다. **Stashes 섹션**의 Stash 행을 클릭하면 해당 Stash의 변경 파일 목록을 인라인으로 펼치고(`Pop`/`Apply`/`Drop` 버튼 클릭과 분리), 펼쳐진 파일 클릭 시 활성 **편집기 영역**에 읽기 전용 **Diff 탭**(**Diff 뷰어**)을 열어 비교하며, 해당 Stash가 제거될 때 무효화된 `stash` **Diff 탭** 자동 닫기 및 `CONTEXT.md` 도메인 용어집 동기화까지 완결합니다.

**Blocked by:** 02-stash-dialog-drop-clear-and-single-file-stash

**Status:** resolved

- [x] 공유 `WikiGitApi.stashDetail` 계약, `git:stash-detail` IPC 채널(활성 워크스페이스 일치 검증 포함), Preload 브리지 메서드, `GitDiffRequest`의 `kind: 'stash'`(`stashRef`, `stashHash`)가 구현되고 IPC/Preload 경계 단위 테스트가 통과합니다.
- [x] Git 서비스의 `stashDetail`과 `diff(kind: 'stash')`가 `stashRef`(`^stash@\{\d+\}$`)·`stashHash`(16진수 `7~64`자)·저장소 경로 경계(`.git` 세그먼트 및 심볼릭 링크 탈출 차단)를 검증하며, 격리된 임시 실제 Git 저장소 통합 테스트에서 추적 변경(`A`/`M`/`D`/`R`), 3번째 부모(`^3`)로 보관된 미추적(`?`) 새 문서, 바이너리 파일 감지, `1MB`(`GIT_DIFF_MAX_BYTES`) 상한 절단(`isTruncated: true`), 현재 디스크 존재 여부(`existsInWorkspace`)를 검증합니다.
- [x] **Stashes 섹션**에서 Stash 항목 행 클릭 시 한 번에 하나의 Stash 상세(`idle`/`loading`/`loaded`/`error`)를 인라인으로 토글하여 보관된 변경 파일 목록(미추적 `?` 포함)을 표시하며, `Pop`·`Apply`·`Drop` 액션 버튼 클릭 시에는 상세 토글이 발생하지 않고 목록 갱신 시 제거된 Stash의 확장 상태가 자동으로 정리됩니다.
- [x] 인라인 Stash 파일 목록의 파일 클릭 시 활성 **편집기 영역**에 읽기 전용 `kind: 'stash'` **Diff 탭**(Stash 맥락 라벨 `stashRef`, **좌우 비교(Side-by-Side)** / **인라인(Inline)** 토글, `existsInWorkspace === true`일 때 편집 가능한 일반 탭으로 여는 `파일 열기` 버튼 포함)이 열리며, 동일 활성 영역의 기존 **Diff 탭** 교체 재사용 및 분할 영역 독립 유지 규칙을 따릅니다.
- [x] `Pop`, `Drop`, `Clear All` 실행으로 특정 `stashHash`가 Stash 목록에서 사라지면 **주 편집기 영역**과 **보조 편집기 영역**에 열려 있던 해당 `stashHash`의 `kind: 'stash'` **Diff 탭**이 자동으로 닫힙니다(`Apply` 시에는 유지, 분할 영역의 마지막 탭이 닫히면 단일 **화면 분할 모드** 복귀).
- [x] `CONTEXT.md` 도메인 용어집에 **Stashes 섹션** 정의를 추가하고 **Git 패널**, **Changes 섹션**, **섹션 리사이저**, **Diff 탭 / Diff 뷰어**, **확인 다이얼로그** 정의를 신규 Stash 기능 어휘와 일치하도록 동기화합니다.
- [x] `<App />` 멀티 윈도우 통합 테스트가 Stash 행 인라인 파일 목록 토글(`loading`/`error`/단일 확장/버튼 클릭 분리), `kind: 'stash'` **Diff 탭** 열기·전환·`파일 열기`·교체 재사용, `Pop`/`Drop`/`Clear All` 시 무효 Stash **Diff 탭** 자동 닫기를 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.
