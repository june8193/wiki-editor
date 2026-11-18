# Spec: Mermaid 다이어그램 블록 리사이즈 핸들 사용성 및 Contain 스케일링 개선

## Problem Statement (문제 정의)

현재 **문서 편집기**의 `Preview`, `Split`, `위지윅` **에디터 모드**에서 렌더링되는 **Mermaid 다이어그램 블록**의 하단 높이 리사이즈 핸들은 여러 구조적 원인이 겹쳐 조작감이 매우 부자연스럽습니다.

- **다이어그램 크기 고정 및 상하 동시 잘림**: 하단 핸들을 드래그해도 `<svg>`의 인라인 `max-width` 제약이 그대로 유지된 채 바깥 컨테이너 높이만 변합니다. 그 결과 아래로 늘리면 다이어그램은 전혀 커지지 않고 위아래 빈 여백만 늘어나며 다이어그램이 커서 속도의 절반(`0.5x`)으로 밀려 내려가고, 위로 줄이면 다이어그램이 축소되는 대신 세로 중앙 정렬(`align-items: center`)과 `overflow: hidden` 때문에 상단과 하단이 동시에 잘려 나갑니다.
- **첫 `1px` 드래그 시 강제 점프(스냅)**: 고정된 높이 제한(`120px ~ 1200px`) 때문에 기본 높이가 `120px` 미만인 가로형 다이어그램은 핸들을 위로 줄이려 해도 첫 `1px` 이동 순간 오히려 `120px`로 확 커지며 튀고, `1200px` 초과 대형 다이어그램은 잡자마자 `1200px`로 급격히 줄어듭니다.
- **문서 맨 아래 다이어그램 확장 불가 및 스크롤 어긋남**: 에디터 스크롤 영역의 하단 패딩이 `16px`뿐이라 문서 끝에 위치한 다이어그램의 핸들이 창 바닥에 바짝 붙어 있고, 드래그 계산이 화면 좌표(`clientY`) 차이만 사용하며 가장자리 자동 스크롤(Edge Auto-Scroll)이 없어 창 바닥에 닿는 순간 더 이상 아래로 늘릴 수 없습니다. 또한 문서 하단에서 높이를 줄일 때 `scrollTop`이 함께 감소하면서 커서와 핸들 위치가 분리됩니다.
- **핸들 배치 이질감 및 위지윅 이중 테두리**: 실제 움직이는 카드 하단 경계선이 아니라 패딩 안쪽에 작은 알약(`36px`)만 떠 있어 조준하기 어렵고, `위지윅` **에디터 모드**에서는 외곽 노드 래퍼와 내부 다이어그램 블록 테두리가 이중으로 겹쳐 있습니다.
- **초기화 수단 부족 및 모드·탭 전환 시 높이 유실**: 수동으로 조절한 높이와 확대·패닝 상태를 한 번에 되돌릴 직관적인 액션 버튼이 없고, 컴포넌트 로컬 상태로만 높이를 보관하여 **에디터 모드**나 탭을 전환하면 방금 조절한 높이가 즉시 초기화됩니다.

## Solution (해결 방안)

인터랙티브 UI 프로토타입 검증을 거쳐 확정된 다음 6가지 개선안을 통합 적용합니다.

1. **Contain 비율 유지 자동 스케일링 + 줌·패닝 연동**:
   - 기본 배율(`100%`)에서 하단 핸들로 블록 높이를 조절하면 `<svg>` 인라인 `max-width` 제약을 해제하고 가용 가로·세로 영역 안에 비율을 유지하며 다이어그램이 함께 확대·축소(`Contain` 피팅)되게 합니다.
   - 다이어그램이 블록 가로 폭 `100%`에 먼저 닿은 뒤 핸들을 아래로 더 끌면, 가로 잘림 없이 다이어그램 기본 크기는 가로 `100%`에서 멈추고 뷰포트(캔버스 창) 높이만 확장되어 확대·패닝 시야 공간을 확보합니다.
   - 피팅된 기본 크기 위에서 기존의 배율 확대·축소(`25% ~ 400%`)와 드래그 패닝이 그대로 동작하며, 클립보드 이미지 복사 및 PNG·SVG 파일 저장은 뷰포트 변형과 무관한 원본 비율 출력을 유지합니다.
2. **동적 높이 범위(`64px ~ 1600px`) 및 첫 `1px` 점프 제거**:
   - 허용 높이 범위를 `[Math.min(64, autoViewportHeightPx), Math.max(1600, autoViewportHeightPx)]`로 동적 산출하여 작은 다이어그램이나 초대형 다이어그램에서도 드래그 시작 순간 크기가 튀지 않고 현재 높이에서 매끄럽게 이어지도록 보장합니다.
3. **문서 스크롤 좌표 기반 드래그 + 가장자리 자동 스크롤 + 문서 하단 여백(`120px`)**:
   - 드래그 계산을 상위 에디터 스크롤 컨테이너의 문서 좌표(`clientY + scrollTop`) 기준으로 전환하고, 커서가 스크롤 영역 상·하단 가장자리에 진입하면 `requestAnimationFrame`으로 높이 확장과 `scrollTop` 이동을 동기화하는 가장자리 자동 스크롤을 수행합니다.
   - `위지윅` 및 `Preview`(`Split` 우측 미리보기 포함) 스크롤 영역의 하단 기본 여백을 `120px`로 넓혀 문서 맨 마지막 다이어그램도 여유 있게 조작할 수 있게 합니다.
4. **단일 카드 통합 및 하단 경계선 전체 폭 히트존 + 높이 배지**:
   - 카드 하단 테두리 전체 가로 폭을 덮는 `14px` 리사이즈 히트존을 배치하고, 호버·포커스·드래그 시 하단 경계선 전체 하이라이트와 확장 그립을 표시하며 드래그 중에는 실시간 높이 수치 배지(`{height}px`)를 노출합니다.
   - `위지윅` **에디터 모드**의 중첩 이중 테두리를 단일 카드 레이아웃(상단 헤더 + 접이식 코드 영역 + 뷰포트 + 하단 경계선 핸들)으로 통합합니다.
5. **통합 `뷰 초기화` 액션 버튼 추가**:
   - 액션 바의 `확대` 버튼 옆에 통합 `뷰 초기화` 아이콘 버튼을 추가하여, 배율·패닝·수동 높이 중 하나라도 변경된 상태에서 클릭 한 번으로 세 가지를 모두 초기 상태로 복원할 수 있게 합니다(기존 `100%` 버튼 클릭 시 배율·패닝 복원, 핸들 더블클릭 시 수동 높이 복원도 유지).
6. **열린 탭 세션 뷰 상태(메모리) 기반 수동 높이 유지**:
   - 마크다운 원문이나 디스크 `workspace-state.json`을 오염시키지 않고, 열린 문서 탭의 메모리 내 뷰 상태에 문서 내 **Mermaid 다이어그램 블록** 순번별 수동 높이를 보존하여 `위지윅` ↔ `Preview` ↔ `Split` 모드 전환 및 탭 전환 후에도 조절한 크기가 유지되게 합니다.

## User Stories (사용자 스토리)

1. As a 위키 작성자, I want **Mermaid 다이어그램 블록**의 하단 핸들을 위아래로 드래그할 때 기본 배율(`100%`)에서 다이어그램 자체가 비율을 유지하며 함께 커지거나 작아지기를 원하며, so that 높이를 줄일 때 상·하단 노드가 잘리지 않고 높이를 키울 때 빈 상자만 늘어나는 어색함 없이 원하는 크기로 맞출 수 있습니다.
2. As a 위키 작성자, I want 가로로 넓은 다이어그램이 블록 가로 폭 `100%`에 도달한 뒤에도 핸들을 아래로 더 끌면 가로가 잘리지 않은 채 뷰포트 창 높이만 더 넓어지기를 원하며, so that 넓은 시퀀스·플로우 다이어그램을 확대(`Zoom In` / `Ctrl+휠`)하고 패닝할 세로 시야 공간을 충분히 확보할 수 있습니다.
3. As a 위키 작성자, I want 기본 높이가 작은 다이어그램(`120px` 미만)이나 매우 긴 다이어그램(`1200px` 초과)의 핸들을 잡았을 때 첫 `1px` 이동에서 크기가 갑자기 튀지 않고 현재 크기부터 연속적으로 조절되기를 원하며, so that 미세한 높이 조정을 위화감 없이 수행할 수 있습니다.
4. As a 위키 작성자, I want 문서 맨 아래에 위치한 **Mermaid 다이어그램 블록**에서도 하단 여유 공간이 확보되고 핸들을 창 바닥 쪽으로 끌면 문서가 자동으로 함께 스크롤되며 높이가 계속 늘어나기를 원하며, so that 마우스를 뗐다 스크롤하고 다시 잡는 반복 작업 없이 한 번의 드래그로 원하는 크기까지 키울 수 있습니다.
5. As a 위키 작성자, I want 카드 하단 테두리 전체 가로 폭 어디든 잡아 끌 수 있고 드래그 중 하단 경계선 하이라이트와 현재 높이(`px`) 배지가 표시되며 `위지윅` **에디터 모드**에서도 이중 테두리 없는 단일 카드로 보이기를 원하며, so that 작은 그립을 정밀 조준하지 않고도 직관적으로 블록 크기를 조절할 수 있습니다.
6. As a 위키 열람자 및 작성자, I want 액션 바의 통합 `뷰 초기화` 버튼으로 줌·패닝·수동 높이를 한 번에 초기 복원하거나, `100%` 버튼으로 배율·패닝만, 핸들 더블클릭으로 높이만 개별 복원하기를 원하며, so that 상황에 맞게 전체 또는 일부 뷰 변형만 빠르게 되돌릴 수 있습니다.
7. As a 위키 작성자, I want 조절해 둔 다이어그램 높이가 마크다운 원문을 변경하지 않으면서도 같은 열린 탭 안에서 `위지윅`·`Preview`·`Split` **에디터 모드**를 전환하거나 다른 탭을 다녀온 뒤에도 그대로 유지되기를 원하며, so that 모드를 오가며 문서를 다듬을 때 매번 높이를 다시 맞추지 않아도 되고 불필요한 미저장 상태나 Git 변경도 생기지 않습니다.

## Implementation Decisions (구현 결정사항)

### 1. Contain 자동 스케일링 및 동적 높이 경계 계약 (UI 프로토타입 확정안)

```ts
// 인터랙티브 UI 프로토타입 및 설계 검토 확정 뷰포트 피팅 계약
export interface MermaidIntrinsicBounds {
  naturalWidth: number
  naturalHeight: number
}

export interface MermaidContainFitMetrics {
  autoViewportHeightPx: number
  minHeightPx: number // Math.min(64, autoViewportHeightPx)
  maxHeightPx: number // Math.max(1600, autoViewportHeightPx)
  fittedSvgWidthPx: number
  fittedSvgHeightPx: number
}
```

- **원본 논리 크기 추출 및 초기 자동 크기 연속성(`0px` 오차 불변식)**:
  - 렌더링된 SVG의 `viewBox`(부재 시 숫자형 `width`·`height`)에서 원본 논리 크기 `(naturalWidth, naturalHeight)`를 파싱합니다(유효한 크기를 얻을 수 없는 비정상 마크업에서는 기존 CSS 반응형 표시로 안전하게 폴백).
  - 뷰포트 내부 가용 가로 폭 `availableWidth`와 상하 패딩 합 `verticalPadding`에 대해 초기 배율 `initialScale = Math.min(1, availableWidth / naturalWidth)` 및 초기 자동 뷰포트 높이 `autoViewportHeightPx = Math.round(naturalHeight * initialScale + verticalPadding)`를 산출합니다.
  - 수동 높이(`customHeightPx`)가 없는 기본 상태에서는 원본 크기 이상으로 과도하게 확대하지 않고 초기 자동 크기를 유지합니다.
  - 수동 높이 `H`가 설정되면 동적 범위 `[Math.min(64, autoViewportHeightPx), Math.max(1600, autoViewportHeightPx)]`로 클램핑하고, 가용 세로 높이 `availableHeight = Math.max(1, H - verticalPadding)`에 대해 `fitScale = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight)`를 계산하여 `<svg>`의 인라인 `max-width` 제한을 해제한 뒤 기본 치수를 `(naturalWidth * fitScale, naturalHeight * fitScale)`로 적용합니다.
  - `H === autoViewportHeightPx`에서 `fitScale === initialScale`이 성립하므로 자동 상태에서 수동 드래그로 진입하는 순간 크기 점프가 발생하지 않습니다.
  - 편집기 창 크기 조절, 사이드바 리사이즈, `Split` 구분선 이동 등으로 컨테이너 가로 폭이 변할 때(`ResizeObserver` 감지)도 `availableWidth`를 재측정하여 피팅 치수를 즉시 갱신합니다.
- **줌·패닝 및 내보내기 독립성**:
  - 스테이지의 `translate(pan.x, pan.y) scale(zoom)` 변형은 피팅된 기본 치수 위에서 동일하게 적용됩니다. 수동 높이가 없는 상태에서 줌·패닝이 발생하면 현재 자동 높이를 잠그고(`lockedAutoHeightPx`), 항등 뷰(`zoom === 1 && pan.x === 0 && pan.y === 0`)로 복귀하면 잠금을 해제합니다.
  - 클립보드 `이미지 복사`와 `PNG 저장`·`SVG 저장`은 뷰포트의 `zoom`·`pan`·`customHeightPx` 영향을 받지 않는 확정 원본 SVG(`confirmedSvg`)를 사용합니다.

### 2. 문서 스크롤 좌표 드래그 및 가장자리 자동 스크롤 상태 머신 (UI 프로토타입 확정안)

- **전역 포인터 드래그 이벤트 단일화**:
  - 드래그 세션이 `pointermove`와 `mousemove`를 동시에 호출해 프레임당 두 번씩 상태를 갱신하지 않도록, `pointerdown`으로 시작된 세션은 `pointermove`/`pointerup`/`pointercancel`만, 구형 `mousedown`으로 시작된 세션(레거시 합성 테스트 호환)은 `mousemove`/`mouseup`만 구독하도록 분리합니다(`blur` 시 종료 안전장치는 공통 유지).
- **문서 좌표(Document-Y) 불변식**:
  - 드래그 시작 시 뷰포트에서 가장 가까운 상위 스크롤 컨테이너(`scrollContainer`)를 탐색합니다(존재하지 않는 단독 마운트 환경에서는 화면 `clientY` 델타로 동작).
  - 시작 시점의 `startHeight`, `startClientY`, `startScrollTop`, 그리고 `startDocY = startClientY - containerRect.top + startScrollTop`을 기록하고, 포인터 이동 및 드래그 중 `scroll` 이벤트마다 `currentDocY = lastClientY - containerRect.top + scrollContainer.scrollTop`으로부터 `nextHeight = clampHeight(startHeight + (currentDocY - startDocY))`를 산출합니다.
- **가장자리 자동 스크롤(Edge Auto-Scroll) 및 최하단 데드락 방지 순서**:
  - 드래그 중 커서가 `scrollContainer` 하단 임계 영역(예: 하단 경계로부터 `36px` 이내 또는 그 아래 바깥)에 있고 시작 위치보다 아래로 움직였을 때(`lastClientY > startClientY + 2`), `requestAnimationFrame` 루프를 구동하여 침투 깊이에 비례하는 프레임당 증가량(`stepPx`)을 계산합니다.
  - 문서 최하단에서는 `scrollTop`이 이미 최대치에 닿아 있어 스크롤을 먼저 증가시킬 수 없으므로, 매 프레임 반드시 **(1) 목표 높이 `clampHeight(currentHeight + stepPx)`를 먼저 상태·DOM에 반영해 `scrollHeight`를 확장한 뒤 → (2) 늘어난 높이(`gain`)만큼 `scrollContainer.scrollTop`을 증가시키고 → (3) 실제 증가한 `scrollTop`이 `gain`보다 작을 경우 실제 스크롤 이동량에 맞춰 높이를 정합화**합니다.
  - 커서가 상단 임계 영역(`36px` 이내 또는 그 위 바깥)에 있고 위로 움직였으며(`lastClientY < startClientY - 2`) `scrollContainer.scrollTop > 0`일 때는 `scrollContainer.scrollTop`을 먼저 감소시킨 뒤 문서 좌표 공식으로 높이를 재계산합니다.
  - 드래그 종료 또는 컴포넌트 언마운트 시 `requestAnimationFrame` 루프와 스크롤·포인터 리스너를 즉시 정리합니다.
- **에디터 스크롤 영역 하단 기본 여백**:
  - `위지윅` 스크롤 컨테이너와 `Preview`(`Split` 우측 미리보기 포함) 스크롤 컨테이너의 하단 패딩을 `120px`로 설정하여 문서 맨 아래 블록의 리사이즈 핸들이 창 바닥 경계에 밀착되지 않게 합니다.

### 3. 단일 카드 구조 · 하단 경계선 핸들 · 통합 `뷰 초기화` 액션 계약

- **하단 경계선 전체 폭 핸들 및 실시간 높이 배지**:
  - 리사이즈 핸들(`role="separator"`, `tabIndex={0}`, `aria-orientation="horizontal"`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`)을 카드 하단 테두리에 걸친 전체 가로 폭 `14px` 히트존으로 배치합니다(뷰포트 패닝 이벤트와 겹치지 않도록 포인터/마우스 다운 전파 차단).
  - 호버, `:focus-visible`, 드래그(`.is-dragging`) 상태에서 카드 하단 경계선 전체(`2px`)와 중앙 그립 바가 강조 색상으로 하이라이트됩니다.
  - 포인터 드래그로 높이를 조절하는 동안(`isResizingHeight === true`)에는 뷰포트 하단 오버레이에 현재 높이 배지(예: `320px`)를 표시하고 드래그가 끝나면 숨깁니다.
  - 핸들에 포커스된 상태에서 `ArrowDown`(`+24px`), `ArrowUp`(`-24px`) 키보드 높이 조절을 지원합니다.
- **위지윅 단일 카드 통합**:
  - `위지윅` **에디터 모드**의 **Mermaid 다이어그램 블록**은 단일 외곽 카드 테두리 안에 상단 헤더(언어 선택 콤보박스, 인라인 액션 바, `코드 편집`/`코드 숨기기` 버튼 및 하단 구분선), 선택적 원문 코드 편집 영역, 다이어그램 뷰포트, 카드 최하단 경계선 핸들이 하나의 표면으로 통합되도록 구성하여 내부 이중 테두리·중복 마진을 제거합니다.
- **액션 바 초기화 동작 구분**:
  - 액션 바의 `확대` 버튼 우측(구분선 좌측)에 통합 `뷰 초기화` 아이콘 버튼(`aria-label="뷰 초기화"`, 툴팁 `"뷰 초기화"`)을 배치합니다.
  - `뷰 초기화` 버튼은 `hasSvg && (!isIdentityViewport || customHeightPx !== null)`일 때만 활성화되며, 클릭 시 배율(`100%`), 패닝(`0, 0`), 수동 높이(`null`)를 모두 초기화합니다.
  - `배율 초기화`(`100%` 수치 버튼) 클릭은 기존대로 배율과 패닝만 초기화하고 수동 높이는 보존하며, 하단 핸들 더블클릭은 수동 높이만 `null`(자동 높이)로 복원하고 현재 배율·패닝은 보존합니다.

### 4. 열린 탭 세션 뷰 상태 기반 수동 높이 보존 및 도메인 용어집 동기화

```ts
// 설계 검토 확정 탭 메모리 뷰 상태 확장 계약 (디스크 workspace-state.json 제외)
export type MermaidDiagramHeightMap = Readonly<Record<string, number>>

export interface DocumentTabRuntimeViewState {
  mermaidHeights?: MermaidDiagramHeightMap // key: 문서 내 0-기반 Mermaid 블록 순번 문자열 ("0", "1", ...)
}
```

- **문서 내 블록 순번 키 매핑**:
  - 각 열린 문서 탭(`DocumentTabItem`)은 메모리 전용 필드로 `mermaidHeights` 맵을 보유합니다.
  - 키는 문서 내 **Mermaid 다이어그램 블록**의 0-기반 등장 순번(`"0"`, `"1"`, ...)을 사용합니다. 이를 통해:
    1. `Preview`, `Split` 우측 미리보기, `위지윅` 세 **에디터 모드** 간 전환 시 동일한 블록 높이가 일관되게 매칭됩니다.
    2. `Split` 또는 `위지윅`에서 다이어그램 코드를 실시간 타이핑해 원문이 바뀌는 도중에도 수동 높이가 풀리지 않습니다.
    3. 동일 문서 내에 같은 초기 템플릿 코드를 가진 두 개의 **Mermaid 다이어그램 블록**이 있어도 서로 독립적인 높이를 유지합니다.
  - 핸들 드래그·키보드 조절 시 해당 순번 키의 높이를 갱신하고, 핸들 더블클릭이나 `뷰 초기화` 실행으로 자동 높이(`null`)가 되면 해당 키를 맵에서 제거합니다.
- **비오염 불변식**:
  - 다이어그램 높이 변경은 마크다운 원문(**문서 버퍼** 본문 및 미저장 상태)을 절대 변경하지 않으며, 디스크 `workspace-state.json` 직렬화 대상에도 포함하지 않습니다(세션 내 열린 탭 메모리에서만 유지).
- **도메인 용어집 동기화**:
  - 도메인 용어집(`CONTEXT.md`)의 **Mermaid 다이어그램 블록** 설명에 비율 유지 자동 스케일링 기반 하단 경계선 높이 조절 및 뷰 초기화 기능을 반영합니다.

## Testing Decisions (테스트 결정사항)

- **검증 기준**: 내부 상태 변수나 사설 헬퍼가 아닌, 사용자가 조작하는 역할(`role="separator"`, `role="toolbar"`, 버튼 이름)·DOM 스타일/치수 결과·모드 및 탭 전환 후 관찰되는 외부 동작을 검증합니다. 모든 테스트는 인메모리 하네스와 주입형 드라이버로 격리합니다.
- **사전 합의된 테스트 심 (Pre-agreed Seams)**:
  1. **`<MermaidDiagram />` 뷰포트·핸들·액션바 공개 컴포넌트 심 (React Testing Library + 주입형 `MermaidDriver` + 모의 레이아웃 `getBoundingClientRect` / `ResizeObserver` / 스크롤 컨테이너 / Vitest)**
     - **Catches**: `Contain` 비율 유지 자동 스케일링 치수 계산 오차(좁은 다이어그램 확대·축소, 가로 폭 `100%` 도달 후 뷰포트만 확장, 자동↔수동 전환 시 첫 `1px` 점프 회귀), 동적 높이 범위(`[min(64, auto), max(1600, auto)]`) 클램프, 문서 스크롤 좌표(`clientY + scrollTop`) 보정 및 상·하단 가장자리 자동 스크롤(`requestAnimationFrame` 최하단 `scrollHeight` 선확장 + `scrollTop` 동기화), 하단 경계선 핸들 드래그 중 높이 배지 노출·키보드 조절·더블클릭 높이 복원, 통합 `뷰 초기화` 버튼 활성화/비활성화 및 일괄 복원(`100%` 버튼·더블클릭과의 역할 분리), 수동 높이·줌 상태에서의 원본 비율 PNG/SVG 내보내기 회귀, 포인터 드래그 중복 이벤트 호출 회귀.
     - **Misses**: 실제 Chromium 브라우저 엔진의 플렉스박스·SVG 서브픽셀 레이아웃 측정 및 OS 하드웨어 포인터 샘플링 주기.
  2. **`<WysiwygMarkdownEditor />`, `<DocumentEditor />`, `<App />` 공개 UI 통합 심 (React Testing Library + 인메모리 `WikiApi` 하네스 + 주입형 `MermaidRenderer`)**
     - **Catches**: `위지윅` 단일 카드 통합 구조(이중 테두리 부재 및 헤더·코드 편집·뷰포트·하단 경계선 핸들 동작)와 마크다운 무변이(미저장 상태 미발생), 동일 탭 내 `위지윅` ↔ `Preview` ↔ `Split` 모드 전환 및 탭 간 전환·실시간 코드 수정 시 블록 순번별 수동 높이 보존 및 초기화 해제 연동, 디스크 `workspace-state.json` 저장 페이로드에 다이어그램 높이가 유입되는 회귀, 에디터 스크롤 컨테이너 하단 기본 여백(`120px`) 스타일 누락.
     - **Misses**: 실제 Electron 네이티브 창 리사이즈 및 고주사율 트랙패드 관성 스크롤 감각.
- *(위 심 목록은 `/ticket-runner`의 사전 합의된 심(Pre-agreed Seams)으로 사용됩니다.)*
- **참고할 기존 테스트 패턴 (Prior Art)**:
  - 기존 **Mermaid 다이어그램 블록** 테스트의 주입형 `MermaidDriver`, 모의 `getBoundingClientRect`, 오프스크린 캔버스 스텁 패턴
  - 기존 `위지윅` 편집기 통합 테스트의 인라인 **Mermaid 다이어그램 블록** 줌·패닝·리사이즈 및 마크다운 무변이 검증 패턴
  - 기존 `<App />` 통합 테스트의 인메모리 `WikiApi` 하네스 기반 모드 전환·탭 전환·`workspaceState` 직렬화 검증 패턴

## Out of Scope (범위 제외 사항)

- **Mermaid 다이어그램 블록**의 가로 폭을 본문 컬럼 폭과 별개로 줄이거나 늘리는 2차원(우측·모서리) 리사이즈 핸들
- 마크다운 원문 코드펜스 메타데이터(예: ```` ```mermaid height=320 ````)나 디스크 `workspace-state.json`에 다이어그램 높이를 영구 기록하는 기능
- 전체화면 모달 다이어그램 뷰어나 미니맵 네비게이터 추가

## Further Notes (기타 참고사항)

- **성능 및 프레임 안정성**: 리사이즈 드래그 중 불필요한 중복 포인터/마우스 이벤트 실행을 방지하고, 가장자리 자동 스크롤 루프는 `requestAnimationFrame` 주기에 맞춰 동작하며 드래그 종료·언마운트 시 즉시 취소되어야 합니다.
- **기존 내보내기·오류 격리 호환**: 문법 오류 시 직전 정상 SVG 유지(`lastValid`) 상태에서 리사이즈·뷰 초기화 조작이 오류 배너나 내보내기 비활성화 불변식을 깨뜨리지 않아야 합니다.
