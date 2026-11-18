# 02 — 문서 스크롤 좌표 기반 리사이즈 및 에디터 하단 여백·가장자리 자동 스크롤

**Spec:** [spec.md](../spec.md)

**What to build:** `위지윅`·`Preview`·`Split` 스크롤 영역에 `120px` 하단 기본 여백을 확보하고, **Mermaid 다이어그램 블록** 리사이즈 드래그를 상위 에디터 스크롤 컨테이너의 문서 좌표(`clientY + scrollTop`) 기준으로 계산하며, 상·하단 가장자리 진입 시 높이 확장과 `scrollTop` 이동을 동기화하는 가장자리 자동 스크롤(Edge Auto-Scroll)을 구현하여 문서 맨 아래 다이어그램도 한 번의 드래그로 자연스럽게 키우고 줄일 수 있게 합니다.

**Blocked by:** `01-contain-scaling-and-unified-card-handle`

**Status:** resolved

- [x] `위지윅` 스크롤 컨테이너와 `Preview`(`Split` 우측 미리보기 포함) 스크롤 컨테이너의 하단 패딩이 `120px`로 적용되어 문서 마지막 **Mermaid 다이어그램 블록**의 하단 핸들이 창 바닥에 밀착되지 않습니다.
- [x] 리사이즈 드래그 중 높이 계산이 상위 스크롤 컨테이너의 문서 Y 좌표(`clientY - containerRect.top + scrollTop`) 변화량을 기준으로 동작하여, 드래그 도중 마우스 휠로 스크롤하거나 문서 하단에서 높이를 줄여 `scrollTop`이 감소하더라도 커서와 핸들 위치가 어긋나지 않습니다.
- [x] 드래그 중 커서가 상위 스크롤 컨테이너 하단 임계 영역(`36px` 이내 또는 아래 바깥)에 위치하고 시작점보다 아래로 이동했을 때, `requestAnimationFrame` 루프가 목표 높이를 먼저 반영해 `scrollHeight`를 확장한 뒤 즉시 늘어난 양만큼 `scrollTop`을 따라 내려 문서 맨 아래에서도 멈춤 없이 높이와 스크롤이 함께 증가합니다.
- [x] 드래그 중 커서가 상위 스크롤 컨테이너 상단 임계 영역(`36px` 이내 또는 위 바깥)에 위치하고 위로 이동했을 때(`scrollTop > 0`), `requestAnimationFrame` 루프가 위로 자동 스크롤하며 문서 좌표 기준으로 높이를 부드럽게 축소합니다.
- [x] 드래그 종료(`pointerup`, `pointercancel`, `mouseup`, `blur`) 및 언마운트 시 자동 스크롤 `requestAnimationFrame` 루프와 스크롤·포인터 리스너가 누수 없이 즉시 해제되며, `Split` 모드의 양방향 스크롤 동기화와도 재귀 루프 없이 동작합니다.
- [x] 사전 합의된 `<MermaidDiagram />` 컴포넌트 심 및 `<DocumentEditor />` 통합 심에서 문서 최하단 자동 스크롤 확장·상단 축소·드래그 중 스크롤 보정·정리 동작을 검증하며, `npm run typecheck`, `npm test`, `npm run build`가 모두 통과합니다.
