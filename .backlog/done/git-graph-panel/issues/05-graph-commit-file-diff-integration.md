# 05 — Graph 섹션 커밋 내 변경 파일 클릭 시 커밋 시점 읽기 전용 Diff 탭 연동

**Spec:** [spec.md](../spec.md)

**What to build:** Git 서비스의 `git:diff` 조회에 특정 커밋 시점 비교(`commit` 소스: 일반·머지 커밋은 첫 번째 부모 대비, 루트 커밋은 빈 트리 대비)를 완성하고, **Graph 섹션**에서 인라인으로 펼쳐진 커밋의 변경 파일을 클릭하면 중앙 **편집 공간**의 활성 **편집기 영역**에 해당 커밋 시점의 읽기 전용 **Diff 탭**을 열어 보여줍니다.

**Blocked by:** 03-commit-inline-detail-and-files, 04-read-only-diff-viewer-and-changes-integration

**Status:** resolved

- [x] Git 서비스의 `commit` 소스 Diff 조회가 커밋 해시 형식을 검증하고, 일반 커밋·머지 커밋(`--first-parent` / `<hash>^1 ↔ <hash>`)·초기 루트 커밋(빈 트리 ↔ `<hash>`)·이름 변경 파일(`-M`)·바이너리 파일에 대해 정확한 패치를 반환함을 격리된 임시 Git 저장소 통합 테스트로 검증합니다.
- [x] 과거 커밋에서는 존재했으나 현재 워킹 트리에서 삭제된 파일·폴더 경로에 대해서도 저장소 루트 내부 및 `.git` 세그먼트 차단 보안 검증을 안전하게 통과해 과거 Diff를 정상 반환하며, 현재 디스크 존재 여부에 따라 `existsInWorkspace`가 `false`(삭제된 파일) 또는 `true`(현존 파일)로 정확히 설정됩니다.
- [x] **Graph 섹션** 인라인 상세 영역에서 변경 파일을 클릭하면 활성 **편집기 영역**에 단축 커밋 해시 맥락이 표시된 읽기 전용 **Diff 탭**(예: `guide.md (a1b2c3d)`)이 열립니다.
- [x] 04번 티켓의 탭 재사용 규칙과 동일하게 활성 **편집기 영역**의 기존 **Diff 탭**(Working/Staged Diff 탭 포함)을 교체 재사용하고 다른 분할 영역에 옮겨 둔 **Diff 탭**은 유지하며, 좌우 비교/인라인 전환 및 `파일 열기` 버튼(`existsInWorkspace === true`일 때 활성, 현재 워크스페이스에서 삭제된 과거 파일일 때 비활성)이 동작합니다.
- [x] `<App />` 통합 테스트가 **Graph 섹션** 커밋 펼침 → 변경 파일 클릭 → 커밋 시점 **Diff 탭** 표시, **Changes 섹션** Diff 탭과의 활성 영역 교체 재사용 및 분할 영역 공존, 현존 파일의 `파일 열기` 동작과 삭제된 과거 파일의 `파일 열기` 비활성화를 검증합니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.

## Comments

- Commits: `dd2b4e5`, `fe54c15`, `227833d`
- Verification: `npm run typecheck`, `npm test` (`45 passed (45)`, `284 passed (284)`), `npm run build` passed; parallel `/code-review` converged to 0 Standards and 0 Spec findings after 3 iterations.
