# 02 — 액티비티 바와 왼쪽 사이드바 뷰 전환·접기

**Spec:** [spec.md](../spec.md)

**What to build:** 앱 본문 좌측 끝에 항상 보이는 액티비티 바를 추가하고, 탐색기(폴더 트리)와 Git 아이콘으로 왼쪽 사이드바에 한 번에 하나의 뷰만 표시합니다. 활성 아이콘을 다시 누르면 사이드바가 접히고, 다른 아이콘을 누르면 해당 뷰로 전환되며 접혀 있었다면 펼쳐집니다. Git 아이콘에는 변경 파일 수 배지를 표시합니다.

**Blocked by:** 01-outline-to-right-sidebar

**Status:** resolved

- [x] 액티비티 바(`aria-label="액티비티 바"` 등 접근 가능한 이름)에 `lucide-react` 아이콘 버튼 `탐색기`, `Git`이 있고, 각 버튼에 `aria-label`·툴팁이 있으며 활성 뷰는 `aria-pressed="true"`와 시각적 강조로 표시됩니다.
- [x] 왼쪽 사이드바는 활성 뷰 하나만 렌더링합니다. 탐색기 뷰에서는 폴더 트리만, Git 뷰에서는 Git 패널만 보입니다.
- [x] 전이 규칙: 펼쳐진 상태에서 활성 아이콘을 다시 누르면 사이드바 본문이 사라지고(액티비티 바는 유지), 접힌 상태에서 아무 아이콘이나 누르면 해당 뷰로 펼쳐지며, 펼쳐진 상태에서 다른 아이콘을 누르면 뷰만 전환됩니다.
- [x] 뷰를 오가도 폴더 트리의 디렉터리 펼침 상태와 Git 상태가 유지됩니다.
- [x] Git 아이콘 배지는 `staged + unstaged + untracked` 합계가 0보다 클 때만 표시되고, 99를 넘으면 `99+`로 표시되며, 저장소가 아니거나 워크스페이스가 없으면 표시되지 않습니다.
- [x] 이 티켓에서는 초기 뷰를 탐색기로 둡니다(워크스페이스 뷰와 초기 뷰 규칙은 03번 티켓 범위). 사이드바 상태는 세션 메모리에만 두고 `config.json`에 저장하지 않습니다.
- [x] 폴더 트리 컨텍스트 메뉴와 Git 브랜치 드롭다운이 사이드바 영역에서 잘리지 않습니다.
- [x] `<App />` 통합 테스트가 뷰 전환, 접기/펼치기 전이, 배지 표시를 검증합니다.
- [x] `CONTEXT.md`에 **액티비티 바**, **탐색기 뷰**, **Git 뷰** 용어를 추가하고 **왼쪽 사이드바**, **폴더 트리**, **Git 패널** 정의를 갱신합니다.
- [x] `npm run typecheck`, `npm test`, `npm run build`가 통과합니다.

## Comments

- Commits: `ff973dc`, `fc73c02`, `9b284f5`
- Verification: `npm run typecheck`, `npm test` (`37 passed (37)`, `221 passed (221)`), `npm run build` passed; parallel `/code-review` converged to 0 Standards and 0 Spec findings after 3 iterations.
