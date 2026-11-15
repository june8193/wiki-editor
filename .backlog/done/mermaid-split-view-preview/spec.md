# Spec: 문서 편집기 Split 모드(Raw + Preview) 및 Mermaid 실시간 미리보기 개선

## Problem Statement (문제 정의)

현재 **문서 편집기**의 **에디터 모드**는 `Raw`(원문 편집), `위지윅`(리치 텍스트 편집), `Preview`(읽기 전용 미리보기) 세 가지 단일 뷰만 제공합니다.

- 마크다운 문서에서 **Mermaid 다이어그램 블록** 코드를 작성할 때 원문과 렌더링 결과를 좌우로 나란히 보려면, **탭 바**에서 탭을 우클릭해 보조 **편집기 영역**에 복제 탭을 열고 모드를 수동으로 전환해야 하는 번거로움이 있습니다.
- 복제 탭을 이용한 우회 방식은 좌우 영역 간 스크롤 동기화가 없어, 긴 문서 중간에 위치한 **Mermaid 다이어그램 블록**을 편집할 때 양쪽 스크롤 위치를 매번 수동으로 맞춰야 합니다.
- 또한 **Mermaid 다이어그램 블록** 코드를 실시간으로 타이핑하는 도중 미완성 구문으로 일시적인 문법 오류가 발생할 때마다(250ms 디바운스 후) 기존 정상 SVG 다이어그램이 즉시 제거되고 큰 오류 박스와 중복 원문 코드로 대체되어, 화면 깜빡임과 문서 높이 급변으로 인한 시선 분산·스크롤 흔들림이 발생합니다.

## Solution (해결 방안)

1. **단일 탭 내 4번째 에디터 모드 `Split` 추가**:
   - **에디터 헤더**의 모드 전환기에 `Raw (Ctrl+1) | 위지윅 (Ctrl+2) | Preview (Ctrl+3) | Split (Ctrl+4)` 구성을 제공하고 `Ctrl+Shift+M` 순환에 `Split`을 포함합니다.
   - `Split` 모드에서는 단일 **문서 편집기** 내부를 좌측 Raw 원문 에디터(**표 편집 툴바**, **슬래시 명령어 메뉴** 포함)와 우측 실시간 Preview로 좌우 분할해 표시합니다.
2. **내부 분할 구분선을 통한 좌우 폭 비율 조절**:
   - `Split` 모드 중앙에 마우스 드래그 및 키보드 좌우 방향키(`±5%`)로 폭 비율(`15% ~ 85%`)을 조절할 수 있는 구분선을 배치하며, 기본 비율은 `5:5(0.5)`이고 더블클릭 시 `5:5`로 즉시 초기화됩니다. 조절된 비율은 탭별 뷰 상태로 유지됩니다.
3. **마크다운 원본 줄 번호 기반 양방향 스크롤 동기화**:
   - Preview 렌더링 시 최상위 마크다운 블록 요소(헤딩, 문단, 목록, 인용, 표, 코드 블록, **Mermaid 다이어그램 블록**)에 원본 시작·끝 줄 번호 메타데이터를 부여하고, 좌측 Raw와 우측 Preview 스크롤을 줄 번호 보간으로 양방향 동기화합니다(재귀 루프 방지 가드 포함).
   - **왼쪽 사이드바**의 **문서 목차**에서 헤딩을 클릭하거나 `/toc` 목차를 삽입할 때도 `Split` 모드의 커서·스크롤이 양쪽 모두 일관되게 동작합니다.
4. **Mermaid 실시간 편집 중 직전 정상 다이어그램 보존**:
   - **Mermaid 다이어그램 블록**에 직전 정상 렌더링된 SVG가 존재하면, 후속 코드 수정 중 문법 오류가 발생하더라도 직전 정상 SVG를 화면에 그대로 유지하면서 간결한 인라인 문법 오류 배너만 함께 표시합니다. (최초 마운트부터 문법 오류라 정상 SVG가 없는 경우에만 기존 오류 박스와 원문 코드를 표시합니다.)

## User Stories (사용자 스토리)

1. **단축키 및 버튼을 통한 Split 모드 전환**: As a markdown author, I want to switch a markdown tab into `Split` mode via the **에디터 헤더** button, `Ctrl+4` (`Cmd+4`), or `Ctrl+Shift+M` mode cycling, so that I can view and edit Raw markdown on the left while seeing rendered output on the right within a single tab.
2. **비마크다운 문서 보호**: As a user editing `config.json`, `.json`, or `.txt` files, I want `Split` mode to remain disabled just like `위지윅` and `Preview`, so that non-markdown buffers stay safely locked to `Raw` mode.
3. **실시간 Mermaid 다이어그램 확인 및 Raw 편집 기능 유지**: As a user writing a **Mermaid 다이어그램 블록** in `Split` mode, I want full Raw editing capabilities (syntax highlighting, **표 편집 툴바**, **슬래시 명령어 메뉴** `/mermaid`·`/toc`, undo/redo) on the left and debounced live SVG rendering on the right, so that I can see diagram changes immediately as I type.
4. **좌우 폭 비율 조절 및 초기화**: As a user working on wide diagrams such as horizontal flowcharts or sequence diagrams, I want to drag or use arrow keys on the `Split` mode divider (between `15%` and `85%`, preserved per tab) and double-click it to reset to `50:50`, so that I can allocate more width to either Raw code or Preview as needed.
5. **원본 줄 번호 기반 양방향 스크롤 동기화**: As a user editing a long markdown document in `Split` mode, I want scrolling either the left Raw editor or the right Preview to smoothly align the other side by source line number without scroll ping-pong loops, so that code and rendered blocks stay aligned despite height differences.
6. **문서 목차 연동**: As a user navigating via **문서 목차** while in `Split` mode, I want clicking an outline heading to scroll both Raw and Preview to that heading and `/toc` insertion to respect the Raw cursor line, so that outline workflows work seamlessly in `Split` mode.
7. **깜빡임 없는 Mermaid 실시간 문법 오류 표시**: As a user typing incomplete Mermaid syntax mid-edit, I want the previously rendered valid SVG diagram to stay visible alongside a compact inline syntax error banner until the syntax becomes valid again, so that the diagram does not vanish or cause layout jumps while I type.

## Implementation Decisions (구현 결정사항)

### 1. 에디터 모드 및 탭 뷰 상태 계약
설계 검토를 통해 확정된 핵심 타입 및 탭 뷰 상태 형태는 다음과 같습니다.

```ts
export type EditorMode = 'raw' | 'preview' | 'wysiwyg' | 'split'

export interface TabItem {
  id: string
  bufferKey: string
  mode: EditorMode
  cursor: CursorPosition
  scrollTop: number
  splitPreviewRatio: number // 초기 기본값 0.5, 허용 클램프 범위 0.15 ~ 0.85
}

export interface TabViewPatch {
  mode?: EditorMode
  cursor?: CursorPosition
  scrollTop?: number
  splitPreviewRatio?: number
}
```

- **모드 전환 순서 및 단축키**:
  - **에디터 헤더** 버튼 순서: `Raw`(`Ctrl+1`) → `위지윅`(`Ctrl+2`) → `Preview`(`Ctrl+3`) → `Split`(`Ctrl+4`).
  - `Ctrl/Cmd+Shift+M` 순환 순서도 버튼 순서와 동일하게 `raw -> wysiwyg -> preview -> split -> raw`로 동작합니다.
  - 마크다운 문서 판별 조건을 충족하지 않는 **문서 버퍼**(`config`, `.json`, `.txt`)에서는 `Split` 버튼과 단축키 전환을 모두 비활성화하고 `raw`로 강제합니다.
  - 모드 전환 시 기존 UI 동작 로깅(`editor-mode-changed`)이 `'split'` 전환도 동일하게 기록합니다.
- **단일 탭 내 동시 마운트 식별자 규칙**:
  - `Split` 모드에서는 좌측 Raw 편집기와 우측 Preview가 동시에 렌더링됩니다. 기존 단일 모드 테스트 및 접근성 계약을 깨지 않도록 좌측 편집기가 주 편집기 테스트 식별자(`document-editor`)를 유지하고, 우측 Preview 컨테이너는 전용 테스트 식별자(`split-markdown-preview`)를 사용하되 접근성 레이블(`마크다운 미리보기`)은 동일하게 유지합니다.

### 2. `Split` 모드 레이아웃 및 내부 분할 구분선 불변식
- **편집 공간**의 2-Pane **화면 분할 모드**(`single` | `horizontal` | `vertical`)와 독립적으로 동작하며, **편집 공간**이 분할된 상태에서도 개별 탭은 `Split` **에디터 모드**를 사용할 수 있습니다(좌우 영역 모두 `min-width: 0` 보장).
- 중앙 내부 구분선(`role="separator"`, `aria-orientation="vertical"`, `aria-valuemin={15}`, `aria-valuemax={85}`)은 다음 조작을 지원합니다:
  - 마우스 드래그로 컨테이너 가로 폭 대비 좌측 비율을 실시간 갱신(`0.15 ~ 0.85` 클램프).
  - 포커스 상태에서 `ArrowLeft`(`-0.05`) / `ArrowRight`(`+0.05`) 키보드 조절.
  - 더블클릭 시 기본 비율 `0.5`로 즉시 복원.
- `splitPreviewRatio`는 탭(`TabItem`) 단위로 보존되어, 다른 탭을 보거나 다른 **에디터 모드**로 전환했다가 돌아와도 유지됩니다.

### 3. 원본 줄 번호 어노테이션 및 양방향 스크롤 동기화 계약
- **새니타이즈 이후 줄 번호 부여**:
  - 마크다운 Preview 렌더링 파이프라인에서 HTML 새니타이즈(`rehype-sanitize`) 단계 **이후**에 동작하는 변환기로 최상위 블록 요소(헤딩, 문단, 목록/목록 항목, 인용, 표 래퍼, 코드 블록, **Mermaid 다이어그램 블록** 래퍼)에 1-기반 시작 줄(`data-source-line`)과 끝 줄(`data-source-end-line`) 속성을 부여합니다. 이를 통해 사용자 작성 원문 HTML이 줄 번호 속성을 위변조할 수 없도록 보장합니다.
- **양방향 선형 보간 매핑**:
  - **Raw → Preview**: 좌측 에디터 스크롤 시 상단 가시 위치에 해당하는 원본 줄 번호(소수점 진행률 포함)를 계산하고, 우측 Preview 내 `[data-source-line]` 블록들의 시작·끝 줄 범위 및 DOM 상단/높이 오프셋 사이를 선형 보간하여 목표 `scrollTop`을 산출합니다(문서 최상단 `0` 및 최하단 끝점 경계 보존).
  - **Preview → Raw**: 우측 Preview 스크롤 시 상단 가시 오프셋이 속한 `[data-source-line]` 블록 구간에서 원본 줄 번호를 역보간하여 좌측 에디터의 해당 줄 오프셋으로 스크롤합니다.
- **무한 루프 방지 가드**:
  - 한쪽 스크롤 이벤트가 반대쪽 `scrollTop`을 프로그래밍 방식으로 갱신할 때, 그로 인해 발생하는 반대쪽 `scroll` 이벤트가 다시 역방향 동기화를 유발하지 않도록 방향 잠금(프로그래밍 동기화 플래그 / 프레임 가드)을 두어 핑퐁 현상을 차단합니다.
- **문서 목차 및 `/toc` 연동**:
  - `Split` 모드에서 **문서 목차**의 헤딩 항목 클릭 시 좌측 Raw 에디터(줄 이동)와 우측 Preview(슬러그/인덱스 이동)가 모두 해당 헤딩으로 스크롤됩니다.
  - `Split` 모드에서 사이드바의 `본문에 목차(/toc) 삽입` 실행 시 `Raw` 모드와 동일하게 현재 커서 위치를 기준으로 동작합니다.

### 4. Mermaid 실시간 편집 중 직전 정상 SVG 보존 계약
- **직전 정상 SVG 캐시 유지**:
  - 마운트된 각 **Mermaid 다이어그램 블록** 인스턴스는 현재 테마에서 마지막으로 성공한 렌더링 SVG(`lastValidSvg`)를 기억합니다(테마가 변경되면 새 테마 기준으로 갱신).
  - 코드 변경 후 디바운스 렌더링이 문법 오류(`ok: false`)를 반환했을 때:
    - **직전 정상 SVG가 있는 경우**: 기존 다이어그램 SVG를 언마운트하지 않고 계속 표시하며, 블록 내부에 간결한 인라인 문법 오류 배너(`role="alert"`, 오류 요약 메시지 포함, 중복 원문 코드 `<pre>` 생략)를 함께 렌더링합니다. 이후 문법이 수정되어 렌더링이 성공하면 새 SVG로 교체하고 인라인 오류 배너를 즉시 숨깁니다.
    - **직전 정상 SVG가 없는 경우**(최초 마운트 시점부터 문법 오류이거나 빈 코드인 경우): 기존과 동일하게 오류 박스(`.mermaid-error-box`, 제목·오류 메시지·원문 코드 포함)를 표시합니다.

### 5. 도메인 용어집 동기화
- 도메인 용어집의 **에디터 모드 (Editor Mode)** 정의를 `Raw`, `위지윅(WYSIWYG)`, `Preview`, `Split`(단일 문서 편집기 내 좌측 Raw 편집 + 우측 Preview 실시간 미리보기) 네 가지 표현 방식으로 갱신하여 **편집 공간** 단위의 **화면 분할 모드**와 혼동되지 않도록 명시합니다.

## Testing Decisions (테스트 결정사항)

- **TDD 및 격리 원칙**: 모든 티켓은 **Red(실패 테스트 선작성) → Green(최소 구현) → Refactor(리팩토링)** 순서로 진행하며, 실제 사용자 설정이나 디스크 파일을 건드리지 않는 인메모리/모의 환경에서 검증합니다.
- **사전 합의된 테스트 심 (Pre-agreed Seams)**:
  1. **`<App />` 및 `<DocumentEditor />` 공개 UI 통합 심 (React Testing Library + 인메모리 `WikiApi` / 주입된 `MermaidRenderer`)**:
     - **Catches**: `Split` 모드 버튼·단축키(`Ctrl+4`, `Ctrl+Shift+M`) 전환, 비마크다운 문서 잠금, 단일 탭 내 좌측 Raw 수정 시 우측 **Mermaid 다이어그램 블록** 실시간 디바운스 갱신, 내부 구분선 드래그·방향키 조절 및 더블클릭 `0.5` 초기화, 탭별 비율 보존, **문서 목차** 헤딩 클릭 이동 및 `/toc` 삽입 연동, `editor-mode-changed` 로그 기록 회귀.
     - **Misses**: 실제 브라우저 레이아웃 엔진의 요소별 픽셀 높이 측정에 따른 정밀 스크롤 보간 수치(jsdom은 레이아웃 높이가 `0`이므로 심 2에서 보완).
  2. **Preview 블록 줄 번호 어노테이션 및 양방향 스크롤 보간 순수 모듈 심 (`renderMarkdownToReact` + 스크롤 매핑 공개 인터페이스 / Vitest)**:
     - **Catches**: 헤딩·문단·표·코드 블록·**Mermaid 다이어그램 블록**의 `data-source-line` / `data-source-end-line` 속성 누락 및 새니타이즈 우회 위변조, Raw 가시 줄 ↔ Preview 블록 오프셋 간 양방향 선형 보간 오차(최상단·최하단 경계 포함), 양방향 스크롤 이벤트 재귀 루프(핑퐁) 회귀.
     - **Misses**: OS 트랙패드/마우스 휠의 관성 스크롤 물리 특성.
  3. **`<MermaidDiagram />` 공개 인터페이스 심 (주입된 `MermaidDriver` + Fake Timers / Vitest)**:
     - **Catches**: 정상 렌더링 이후 후속 편집 중 문법 오류 발생 시 직전 정상 SVG가 사라지거나 중복 원문 코드 박스로 대체되는 깜빡임 회귀, 인라인 오류 배너 표시 및 정상 문법 복구 시 배너 제거 실패, 최초 마운트 시점부터 문법 오류인 블록의 기존 오류 박스 폴백 누락, 테마 전환 시 SVG 테마 동기화 오류.
     - **Misses**: 실제 `mermaid` 패키지의 브라우저 내 SVG 도형 배치 세부 결과.
- **참고할 기존 테스트 패턴 (Prior Art)**:
  - `<App />` 통합 테스트의 인메모리 `WikiApi` 하네스 및 탭/분할/목차 상호작용 검증 패턴
  - `<DocumentEditor />` 및 `editorModes` 테스트의 모드 전환 버튼·단축키·비마크다운 잠금 검증 패턴
  - `<MermaidDiagram />` 테스트의 주입형 `MermaidDriver` 및 `vi.useFakeTimers()` 디바운스/오류 복구 검증 패턴

## Out of Scope (범위 제외 사항)

- **위지윅** 모드 내부 **Mermaid 다이어그램 블록**의 별도 좌우 분할 레이아웃 변경
- 커서가 **Mermaid 다이어그램 블록**에 있을 때 일반 줄 번호 보간 대신 우측 화면에 특정 블록만 고정(핀)하는 특수 스크롤 모드
- 탭별 `splitPreviewRatio`의 디스크(`config.json`) 영구 저장 (세션 내 탭 메모리 상태로만 유지)

## Further Notes (기타 참고사항)

- **성능 고려사항**: `Split` 모드에서 타이핑할 때마다 마크다운 Preview가 갱신되더라도, 이미 정상 렌더링된 동일 소스의 **Mermaid 다이어그램 블록**은 기존 `MermaidRenderer`의 해시·테마 LRU 캐시를 즉시 히트하므로 수정 중인 블록만 250ms 디바운스 후 재렌더링됩니다.
