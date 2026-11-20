# Spec: 프론트매터 작성 및 프론트매터 기반 문서 검색·필터링

## Problem Statement (문제 정의)

현재 앱은 로컬 마크다운 문서를 **폴더 트리** 계층과 텍스트 키워드(**검색 패널** · **문서 내 찾기 바**)로만 탐색할 수 있을 뿐, Jira처럼 문서별로 구조화된 메타데이터(예: `status`, `priority`, `labels`, `assignee`, `dueDate`)를 정의·작성하고 이를 기준으로 문서를 검색·필터링·정렬할 수 없습니다.

- 문서 수가 많아지면 특정 상태(`in-progress`), 우선순위(`high`), 라벨(`backend`, `security`)에 해당하는 문서를 모아보거나 복합 조건으로 필터링하기 위해 파일명이나 본문을 일일이 열어 확인해야 합니다.
- 팀이나 여러 PC에서 Git으로 공유되는 위키 워크스페이스에 공통 메타데이터 스키마 규격을 두고 일관된 폼 UI로 작성할 방법이 없습니다.
- 현재 `위지윅` · `Preview` · `Split` **에디터 모드**와 **문서 목차** 파이프라인에 프론트매터 처리가 없어, 표준 YAML 프론트매터(`--- ... ---`)가 포함된 문서를 열면 `Preview`에서 구분선(`<hr>`)·텍스트로 깨져 보이거나 `위지윅` 편집 시 YAML 블록이 손상되고, YAML 주석(`#`)이 **문서 목차**의 헤딩으로 오인될 위험이 있습니다.
- 자동 저장이 기본 비활성(`autoSave: false`)인 환경에서 아직 저장하지 않은 **문서 버퍼**의 프론트매터 변경분까지 즉시 검색·필터 결과에 반영되어야 합니다.

## Solution (해결 방안)

워크스페이스 단위 **프론트매터 스키마** 정의부터 **우측 사이드바** 2단 아코디언 작성 UI, 전 **에디터 모드** 비파괴 파이프라인 통합, 그리고 **검색 뷰** 통합 필터·정렬·배지 클릭 연동까지 엔드투엔드로 제공합니다.

1. **워크스페이스 사전 정의 프론트매터 스키마 (Jira 스타일)**: 워크스페이스 루트 `.wiki-editor/frontmatter.json`에 6종 타입(`text`, `number`, `boolean`, `date`, `select`, `multi-select` with `allowCustom`) 기반 스키마를 저장해 Git으로 공유합니다. 스키마가 없는 워크스페이스에서는 `'스키마 생성'` 액션으로 기본 템플릿을 초기화하며, 전용 **스키마 관리 모달**과 `.wiki-editor/frontmatter.json` Raw JSON 탭 직접 편집을 모두 지원합니다.
2. **비파괴 YAML 프론트매터 처리 및 4개 에디터 모드 정합성**: 문서 최상단의 표준 YAML 프론트매터(`--- ... ---`)를 파싱·검증·직렬화할 때 스키마 미정의 키·주석·복잡한 YAML·줄바꿈(CRLF/LF)·문법 오류 원문을 절대 삭제하지 않고 보존하며, 유효성 위반은 저장을 차단하지 않는 소프트 경고로 안내합니다. `Raw` · `위지윅` · `Preview` · `Split` **에디터 모드**와 **문서 목차** · **문서 내 찾기 바** · 검색 점프가 프론트매터 줄 오프셋과 본문을 일관되게 처리합니다.
3. **우측 사이드바 2단 아코디언 (문서 목차 · 문서 속성 섹션)**: 기존 **Git 패널**과 동일한 아코디언 + 수평 **섹션 리사이저** 패턴으로 **우측 사이드바**에 **문서 목차**(상단)와 **문서 속성 섹션**(하단)을 배치합니다. 모든 **에디터 모드**와 **메인 창**·**보조 창**에서 본문 스크롤과 무관하게 프론트매터를 확인·편집하며 `Raw`/`Split` YAML 및 공유 **문서 버퍼**와 실시간 양방향 동기화합니다.
4. **검색 뷰 통합 프론트매터 필터·정렬·배지 클릭 연동**: 기존 **검색 패널**(`Ctrl+Shift+F`)의 텍스트 검색창 아래에 세션 비영속 **프론트매터 필터 바**를 배치해 속성 필터 단독 조회와 파일명·본문 텍스트 검색(`Aa`/`ab`/`.*`) 결합을 한 곳에서 처리합니다. 타입별 표준 실용 연산자(조건 간 AND), 결과 요약 배지 표시, 스키마 옵션 순서 기반 정렬, 결과 배지 클릭 즉시 필터 추가, 미저장 **문서 버퍼** 우선 반영을 지원합니다.

## User Stories (사용자 스토리)

1. As a 위키 작성자, I want 스키마가 없는 워크스페이스에서 `'스키마 생성'` 액션으로 `.wiki-editor/frontmatter.json` 기본 템플릿을 초기화하고 Git으로 팀원·다른 PC와 공유하기를 원하며, so that 워크스페이스 전체 문서에 일관된 Jira형 메타데이터 필드를 적용할 수 있습니다.
2. As a 위키 작성자, I want **스키마 관리 모달**에서 6종 타입(`text`, `number`, `boolean`, `date`, `select`, `multi-select`) 필드·선택지 옵션·`allowCustom`·필수 여부·배지 색상·순서를 편집하거나 `.wiki-editor/frontmatter.json`을 Raw JSON 탭으로 열어 직접 수정하고 즉시 반영되기를 원하며, so that GUI 편의성과 JSON 직접 제어 중 상황에 맞는 방식을 쓸 수 있습니다.
3. As a 위키 작성자, I want **우측 사이드바**가 **문서 목차**(상단)와 **문서 속성 섹션**(하단) 2단 아코디언으로 구성되어 각각 독립적으로 접고 펼치며 둘 다 펼쳤을 때 수평 **섹션 리사이저**로 높이 비율을 조절할 수 있기를 원하며, so that 문서 구조와 속성을 한눈에 동시에 보거나 필요한 섹션만 넓혀 작업할 수 있습니다.
4. As a 위키 작성자, I want **문서 속성 섹션**에서 6종 타입 위젯으로 속성을 작성·수정(`+ 속성 추가`, `프론트매터 제거`, `allowCustom` `multi-select` 자유 라벨 입력 + 워크스페이스 기존 값 제안)하면 **문서 버퍼**가 즉시 갱신되고 `Raw`/`Split` YAML 원문과 양방향 실시간 동기화되기를 원하며, so that YAML 문법을 직접 쓰지 않고도 안전하게 프론트매터를 관리할 수 있습니다.
5. As a 위키 작성자, I want 스키마에 미정의된 기존 키나 복잡한 YAML·주석이 편집·저장 시 삭제되지 않고 `'미정의 필드 (N) · 보존'` 접이식 영역으로 참고 표시되며, 필수 누락·허용 외 옵션·타입 불일치·날짜 형식·YAML 문법 오류는 저장을 막지 않는 소프트 경고로 표시되기를 원하며, so that 기존 문서나 수작업 YAML이 손상되지 않으면서도 스키마 위반을 바로 인지할 수 있습니다.
6. As a 위키 작성자, I want 프론트매터가 있는 마크다운 문서를 열었을 때 `위지윅` 편집에서 프론트매터가 손실되지 않고, `Preview`와 `Split` 우측에서 원문 YAML 블록이 숨겨진 채 정확한 줄 동기화와 **문서 목차**·**문서 내 찾기 바**·검색 점프가 동작하기를 원하며, so that 어느 **에디터 모드**를 쓰더라도 프론트매터가 본문 렌더링이나 줄 위치를 망가뜨리지 않습니다.
7. As a 위키 작성자, I want **메인 창**뿐 아니라 탭을 분리한 **보조 창**에서도 동일한 **우측 사이드바** 2단 아코디언과 **문서 버퍼**·스키마 동기화가 동작하기를 원하며, so that 보조 창으로 문서를 옮겨 편집할 때도 속성을 끊김 없이 확인·수정할 수 있습니다.
8. As a 위키 작성자, I want **검색 뷰**(**검색 패널**, `Ctrl+Shift+F`)의 기존 텍스트/정규식 검색창 아래에 **프론트매터 필터 바**(활성 필터 칩 + `'+ 필터 추가'` 키보드 검색 피커)를 사용해 속성 필터 단독으로 문서를 찾거나 파일명·본문 검색과 결합하기를 원하며, so that 정규식 검색과 충돌 없이 다차원 문서 탐색이 가능합니다.
9. As a 위키 작성자, I want 서로 다른 필드 조건 간 AND 결합과 함께 타입별 표준 실용 연산자(`select` 포함/제외/비어있음, `multi-select` 모두 포함/하나라도 포함/제외/비어있음, `text` 포함/일치/비어있음, `number`·`date` `=`/`>=`/`<=`/범위/비어있음, `boolean` 예/아니오/비어있음)를 쓰기를 원하며, so that "우선순위가 높고 보안 라벨을 포함하며 마감일이 이번 주까지인 문서" 같은 실무 조건을 정확히 걸러낼 수 있습니다.
10. As a 위키 작성자, I want `allowCustom`이 켜진 `multi-select` 필드(예: `labels`)를 필터링하거나 작성할 때 스키마에 적힌 옵션뿐 아니라 워크스페이스 문서(미저장 **문서 버퍼** 포함)에 실제로 입력된 커스텀 값도 후보로 제안받기를 원하며, so that 문서 작성 중 자유롭게 추가한 라벨도 빠짐없이 필터링할 수 있습니다.
11. As a 위키 작성자, I want **검색 패널** 결과 행에 주요 프론트매터 요약 배지가 표시되고, 스키마 필드 오름/내림차순(`select`는 옵션 정의 순서 우선, 빈 값은 후순위)으로 정렬하며, 결과의 배지를 클릭하면 해당 조건이 필터에 즉시 추가되기를 원하며, so that Jira 이슈 목록처럼 결과를 빠르게 훑고 좁혀갈 수 있습니다.
12. As a 위키 작성자, I want **검색 패널**의 프론트매터 필터·정렬 상태가 **왼쪽 사이드바** 다른 뷰 전환이나 접기 후에도 세션 중에는 유지되고, 워크스페이스를 전환하거나 앱을 종료하면 깨끗하게 초기화되기를 원하며, so that 현재 작업 맥락은 유지하되 다른 워크스페이스 탐색과 섞이지 않습니다.

## Implementation Decisions (구현 결정사항)

### 확정된 핵심 계약 형태 (설계 인터뷰 · 프로토타입 확정 계약)

아래 계약 형태는 `/grill-me` 설계 인터뷰 및 우측 사이드바 아코디언 UI 프로토타입 검토를 통해 확정된 공유 타입·IPC 계약입니다.

```ts
export type FrontmatterFieldType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'select'
  | 'multi-select'

export interface FrontmatterOptionSpec {
  value: string
  color?: string
}

export interface FrontmatterFieldDefinition {
  key: string
  label: string
  type: FrontmatterFieldType
  required?: boolean
  placeholder?: string
  options?: FrontmatterOptionSpec[]
  allowCustom?: boolean
  showInSearchBadge?: boolean
}

export interface WorkspaceFrontmatterSchema {
  version: 1
  fields: FrontmatterFieldDefinition[]
}

export interface FrontmatterSchemaLoadResult {
  exists: boolean
  path: string
  schema: WorkspaceFrontmatterSchema | null
  error?: string
}

export type FrontmatterValidationCode =
  | 'yaml-syntax-error'
  | 'required-missing'
  | 'type-mismatch'
  | 'disallowed-option'
  | 'invalid-date-format'

export interface FrontmatterValidationIssue {
  key?: string
  code: FrontmatterValidationCode
  message: string
}

export type FrontmatterScalarValue = string | number | boolean
export type FrontmatterFieldValue = FrontmatterScalarValue | string[]

export interface ParsedFrontmatterDocument {
  hasFrontmatter: boolean
  rawBlock: string
  body: string
  bodyStartLine: number // 1-based line number where markdown body begins
  values: Record<string, FrontmatterFieldValue>
  unknownEntries: Array<{ key: string; rawValue: string }>
  issues: FrontmatterValidationIssue[]
}

export type FrontmatterFilterOperator =
  | 'in'
  | 'not-in'
  | 'all-of'
  | 'any-of'
  | 'none-of'
  | 'contains'
  | 'equals'
  | 'gte'
  | 'lte'
  | 'between'
  | 'is-empty'

export interface FrontmatterFilterCondition {
  fieldKey: string
  operator: FrontmatterFilterOperator
  values?: string[]
  value?: string | number | boolean
  min?: string | number
  max?: string | number
}

export interface WorkspaceSearchSortSpec {
  by: 'path' | 'frontmatter'
  fieldKey?: string
  direction: 'asc' | 'desc'
}

export interface WorkspaceSearchFrontmatterQuery {
  conditions: FrontmatterFilterCondition[]
  sort?: WorkspaceSearchSortSpec
}

// WorkspaceSearchRequest 확장 필드:
//   frontmatter?: WorkspaceSearchFrontmatterQuery
// WorkspaceSearchFileResult 확장 필드:
//   frontmatterSummary?: Record<string, FrontmatterFieldValue>

export interface WorkspaceFrontmatterFieldValuesResponse {
  valuesByField: Record<string, string[]>
}
```

### 아키텍처 및 전이 규칙

- **YAML 프론트매터 비파괴 파싱 · 직렬화 · 검증 엔진**:
  - 문서 최상단 1행(선행 UTF-8 BOM 선택적 허용)이 `---`로 시작하고 대응하는 닫는 구분선(`---` 또는 `...`)이 존재하는 표준 YAML 블록만 프론트매터로 인식하며, 본문 중간의 `---` 수평선(Thematic Break)을 프론트매터로 오인하지 않습니다.
  - 문서의 원본 줄바꿈 형식(CRLF/LF)을 감지·보존하고, `bodyStartLine`(1-기반 본문 시작 줄 번호)을 정확히 계산합니다.
  - 스키마 필드를 수정·추가·제거할 때 기존 YAML 주석, 스키마에 없는 키, 중첩 객체/복잡한 YAML 구조는 삭제하거나 재포맷하지 않고 원문을 보존합니다.
  - 닫는 구분선이 없거나 YAML 구문 오류가 있는 블록은 원문을 유지한 채 `yaml-syntax-error` 경고를 반환하며, 문법 오류 상태에서 GUI 입력이 미파싱 원문을 덮어써 파괴하지 않도록 안전 가드(GUI 수정 비활성 또는 Raw 편집 안내)를 둡니다.
  - 유효성 검증 규칙(모두 비차단 소프트 경고):
    - `required` 필드가 비어 있으면 `required-missing`
    - `select` 값이 `options`에 없거나 `allowCustom === false`인 `multi-select` 항목 중 `options`에 없는 값이 포함되면 `disallowed-option`
    - `number`·`boolean`·`multi-select` 타입이 맞지 않으면 `type-mismatch`
    - `date` 값이 실존하는 `YYYY-MM-DD` 형식이 아니면 `invalid-date-format`
- **워크스페이스 스키마 서비스 · 세션 IPC · 감시 동기화**:
  - 각 **메인 창** 세션은 자신의 워크스페이스 루트 내부 `.wiki-editor/frontmatter.json`만 경로 보안 검증(루트 탈출·심볼릭 링크 차단) 하에 읽고 원자적으로 저장합니다(타 **메인 창** 세션과 완전 격리).
  - 스키마 파일 부재 시 예외 대신 `{ exists: false, schema: null }`를 반환하고, `'스키마 생성'` 호출 시 기존 파일이 없을 때 기본 Jira형 스타터 템플릿(`status`, `priority`, `labels(allowCustom: true)`, `assignee`, `dueDate`)으로 `.wiki-editor/frontmatter.json`을 원자적으로 초기화합니다.
  - 저장 및 외부 로드 시 `version === 1`, 유효한 `FrontmatterFieldType`, 중복 키 금지, 비어 있지 않은 `key`/`label` 및 `select`/`multi-select` 옵션 유효성을 엄격 검증합니다.
  - `.wiki-editor/frontmatter.json`이 Raw JSON 탭에서 저장되거나 파일시스템 감시 이벤트로 변경되면 스키마를 재로드·검증해 현재 **메인 창**과 소속 **보조 창**에 즉시 브로드캐스트합니다. 잘못된 JSON/스키마가 디스크에 저장되더라도 크래시 없이 오류 상태를 알리고 기존 문서 프론트매터 원문은 보존합니다.
- **4개 에디터 모드 · 문서 목차 · 문서 내 찾기 바 · 검색 점프 통합**:
  - `위지윅`: TipTap에는 프론트매터를 제외한 `body`만 전달하고, 편집 직렬화 시 원본 `rawBlock`과 줄바꿈을 선두에 무손실 재결합합니다. **문서 속성 섹션**에서 프론트매터만 변경될 때는 `body`가 동일하므로 TipTap 편집 상태와 커서를 불필요하게 재설정하지 않습니다.
  - `Preview` 및 `Split` 우측 미리보기: `body`만 마크다운 렌더링하여 원문 YAML 블록이 `<hr>`나 문단으로 노출되지 않게 하고, 렌더링된 최상위 블록의 `data-source-line` / `data-source-end-line`에 `bodyStartLine - 1` 오프셋을 가산해 `Split` 줄 동기화 스크롤 및 검색 점프 줄 번호가 1-기반 `Raw` 원문과 정확히 일치하도록 유지합니다.
  - **문서 목차**: 프론트매터 줄 구간을 헤딩 스캔에서 제외해 YAML `#` 주석이 헤딩으로 오인되지 않도록 하고, 본문 헤딩의 1-기반 `line` 번호는 전체 문서(`Raw`) 기준으로 정확히 산출합니다.
  - **문서 내 찾기 바** 및 **검색 뷰** 점프: `Raw`·`Split`은 프론트매터를 포함한 1-기반 원문 줄·컬럼을 그대로 탐색·점프하며, `Preview`·`위지윅`은 렌더링된 본문 대상으로 매칭·강조합니다. 프론트매터 구간 줄(`lineNumber < bodyStartLine`)로 점프 요청이 오면 `Preview`·`위지윅`에서는 예외 없이 문서 최상단으로 안전 폴백합니다.
- **우측 사이드바 2단 아코디언 (문서 목차 · 문서 속성 섹션)**:
  - 기존 **Git 패널**의 2단 아코디언 및 수평 **섹션 리사이저** 패턴(높이 비율 `20%~80%`, 포인터 드래그·`ArrowUp`/`ArrowDown`·더블클릭 `50%` 복원)을 공용화해 **우측 사이드바**에 적용합니다.
  - 기본 배치는 상단 **문서 목차**(`35%`) / 하단 **문서 속성 섹션**(`65%`)이며, 한쪽을 접으면 펼쳐진 섹션이 전체 높이를 채우고 양쪽 모두 접으면 헤더만 상단에 정렬됩니다. 기존 좌측 경계 **사이드바 리사이저**(`180px~500px`)와 우측 접기 탭을 유지합니다.
  - **메인 창**과 **보조 창** 모두 동일한 **우측 사이드바** 아코디언을 제공하며, 비마크다운 파일(`config.json`, `.txt`), **Diff 탭**, 이미지 미리보기 탭에서는 **문서 속성 섹션**에 마크다운 전용 안내를 표시합니다.
  - **문서 속성 섹션** 헤더에는 채워진 필드 수 배지(`n/m`), 경고 배지(`⚠ k`), `⚙`(**스키마 관리 모달**) 버튼을 배치하고 보조 버튼 클릭 시 아코디언 토글 전파를 차단합니다. 본문에는 6종 타입 컴팩트 폼, `allowCustom` `multi-select` 칩·Enter 입력·제안 목록(스키마 옵션 + 워크스페이스 실사용 값), 접이식 `'미정의 필드 (N) · 보존'`, 빈 문서 `'+ 속성 추가'`, `'프론트매터 제거'`, 스키마 미존재 시 `'스키마 생성'` 액션을 제공합니다.
  - **문서 속성 섹션** 편집은 즉시 공유 **문서 버퍼**를 갱신(`dirty` 표시, 저장/자동 저장 연동)하며 `Raw`/`Split` YAML 편집기와 실시간 양방향 동기화(Raw 입력 중 커서·포커스 유지)됩니다.
- **스키마 관리 모달**:
  - **문서 속성 섹션** 헤더의 `⚙` 버튼이나 스키마 미생성/오류 안내에서 여닫을 수 있으며, 열려 있는 동안 에디터·전역 단축키를 억제합니다(`Esc`·닫기 버튼 지원).
  - 6종 타입 필드 추가·수정·삭제·순서 변경, `required`·`placeholder`·`showInSearchBadge` 설정, `select`/`multi-select` 선택지(옵션) 추가·삭제·순서 변경·배지 색상 설정, `multi-select`의 `allowCustom` 토글 및 저장 전 중복 키/필수 값 검증을 제공합니다.
  - `'JSON 파일로 열기'` 버튼으로 `.wiki-editor/frontmatter.json`을 활성 **편집기 영역**의 일반 Raw JSON 탭으로 열어 직접 편집할 수 있습니다.
- **검색 뷰 프론트매터 필터링 · 정렬 · 배지 클릭 연동**:
  - **검색 패널**의 기존 텍스트 검색창(`Aa`/`ab`/`.*` 옵션 포함) 아래에 **프론트매터 필터 바**(활성 필터 칩 + `'+ 필터 추가'` 키보드 검색 팝오버 + 전체 초기화)와 정렬 드롭다운을 배치합니다.
  - 프론트매터 필터 조건이 1개 이상이면 텍스트 검색어가 비어 있어도 속성 단독 필터링을 실행하고, 텍스트 검색어와 함께 입력되면 교집합을 반환합니다.
  - 프론트매터 필터 및 `allowCustom` 커스텀 값 수집 대상은 마크다운 문서(`.md`, `.markdown`, 확장자 없는 텍스트 파일; `.wiki-editor/`·기존 무시 폴더·바이너리·`2MB` 초과·탈출/순환 심볼릭 링크 제외)이며, 현재 **메인 창** 세션의 미저장 열린 **문서 버퍼**(소속 **보조 창** 포함)를 디스크보다 우선 반영하고 `config.json` 버퍼는 제외합니다. 후속 검색 시 이전 미완료 스캔은 `AbortSignal`로 취소합니다.
  - 연산자 규칙: 서로 다른 조건 간 AND 결합; `select`(`in`/`not-in`/`is-empty`), `multi-select`(`all-of`/`any-of`/`none-of`/`is-empty`), `text`(`contains` 대소문자 무시/`equals`/`is-empty`), `number`·`date`(`equals`/`gte`/`lte`/`between`/`is-empty`), `boolean`(`equals`/`is-empty`).
  - 정렬 규칙: 기본 경로순(`path`) 외 스키마 필드 오름/내림차순을 지원합니다. `select` 필드는 스키마 `options` 선언 순서를 우선 비교하며(스키마 외 값은 그 뒤 알파벳순), `number`는 수치 비교, `date`는 날짜 비교, `text`/`multi-select`는 로케일 비교, `boolean`은 `true`/`false` 기준으로 정렬하고 빈 값/미지정 값은 오름·내림차순 모두 항상 후순위에 배치합니다(동률 시 `relativePath` 오름차순).
  - 검색 결과 각 파일 행에 `showInSearchBadge` 대상(또는 주요 스키마) 프론트매터 값 요약 배지를 표시하며, 배지 클릭 시 해당 필드·값 조건을 **프론트매터 필터 바**에 즉시 추가/적용합니다.
  - 필터·정렬 상태는 세션 비영속으로 **왼쪽 사이드바** 뷰 전환·접기 시 메모리에 유지되고 워크스페이스 전환 시 초기화되며 `workspace-state.json`에는 저장하지 않습니다.
- **도메인 용어집 동기화 (`CONTEXT.md`)**:
  - **프론트매터 스키마 (Frontmatter Schema)**, **문서 속성 섹션 (Document Properties Section)**, **스키마 관리 모달 (Schema Management Modal)**, **프론트매터 필터 바 (Frontmatter Filter Bar)**를 공식 어휘로 등록하고, **우측 사이드바**, **검색 패널**, **문서 편집기**, **섹션 리사이저**, **보조 창** 설명을 최신 동작에 맞게 갱신합니다.

## Testing Decisions (테스트 결정사항)

- **검증 기준**: 내부 헬퍼나 비공개 상태가 아니라 사용자 관점의 외부 관찰 동작(스키마 초기화·편집·공유, 6종 타입 작성·비파괴 보존·소프트 경고, 4개 **에디터 모드**·**문서 목차**·**문서 내 찾기 바**·검색 점프 정합성, **우측 사이드바** 2단 아코디언·**섹션 리사이저**·**보조 창** 동기화, **검색 패널** 필터 연산자·정렬·배지 클릭·미저장 **문서 버퍼** 우선 반영·세션 비영속/격리)과 메인-렌더러 IPC 공개 계약을 기준으로 검증합니다. 모든 테스트는 임시 디렉터리 또는 인메모리 하네스로 격리합니다.
- **사전 합의된 테스트 심 (Pre-agreed Seams)**:
  1. **메인 프로세스 프론트매터 스키마·검색 서비스 및 세션 IPC 통합 테스트 심** (임시 디렉터리 파일시스템 · 공유 **문서 버퍼** 허브 · 가짜 `ipcMain` · 프리로드 브리지 하네스 + 공용 YAML 프론트매터 엔진 공개 계약)
     - **Catches**: `.wiki-editor/frontmatter.json` 로드·초기화·엄격 검증·원자적 저장·경로 탈출/심볼릭 링크 차단 및 외부 변경 재로드, 6종 필드 타입 파싱·유효성 경고(`required-missing`, `disallowed-option`, `type-mismatch`, `invalid-date-format`, `yaml-syntax-error`)·미정의 키/주석/복잡 YAML/CRLF-LF 비파괴 라운드트립 보존, 속성 필터 단독 조회 및 텍스트/정규식(`Aa`/`ab`/`.*`) 결합 검색, 전 연산자(`in`/`not-in`/`all-of`/`any-of`/`none-of`/`contains`/`equals`/`gte`/`lte`/`between`/`is-empty`) 정확도, `select` 스키마 옵션 순서 정렬 및 빈 값 후순위 배치, `allowCustom` 커스텀 값 수집, 현재 **메인 창** 세션 미저장 **문서 버퍼**(소속 **보조 창** 포함) 우선 반영 및 타 **메인 창** 세션 격리, `.wiki-editor/`·바이너리·`2MB` 초과 제외 및 동시 검색 취소 회귀.
     - **Misses**: 렌더러 React UI 렌더링, **우측 사이드바** 아코디언 포인터 드래그·키보드 초점 이동, CodeMirror·TipTap·Preview DOM 렌더링 및 스크롤 정합성.
  2. **`<App />` 통합 · 멀티윈도우 및 `<DocumentEditor />` 공개 UI 테스트 심** (인메모리 워크스페이스·공유 **문서 버퍼**·창 코디네이터 `WikiApi` 하네스 + 4개 **에디터 모드**·**우측 사이드바**·**검색 뷰** 렌더링)
     - **Catches**: **스키마 관리 모달**의 필드/옵션 CRUD·순서 변경·`'스키마 생성'`·`'.wiki-editor/frontmatter.json'` Raw JSON 탭 열기/저장 및 다중 창 스키마 동기화, **우측 사이드바** **문서 목차**·**문서 속성 섹션** 2단 아코디언 접기/펼치기·**섹션 리사이저**(드래그·방향키·더블클릭)·**사이드바 리사이저**·**보조 창** 일관성, 6종 타입 위젯 작성·소프트 경고 배지·접이식 `'미정의 필드'`·`+ 속성 추가`/`프론트매터 제거`, `Raw`/`Split` YAML 양방향 동기화 및 `위지윅`·`Preview`·**문서 목차**·**문서 내 찾기 바**·검색 점프의 프론트매터 비파괴/줄 오프셋 정합성, **검색 패널** **프론트매터 필터 바**(`+ 필터 추가` 피커·칩 편집/제거·커스텀 라벨 자동 제안), 속성 단독·본문 결합 검색, 요약 배지 표시·배지 클릭 즉시 필터 추가·정렬 전환·세션 비영속 초기화 회귀.
     - **Misses**: 실제 OS 파일시스템 디스크 I/O·심볼릭 링크·원자적 파일 치환 실패 조건, 실제 Chromium 페인트 레이아웃의 서브픽셀 스크롤 위치.
- *(위 심 목록은 Step 4에서 사용자 승인 시 `/ticket-runner`의 사전 합의된 심(Pre-agreed Seams)으로 사용됩니다.)*
- **참고할 기존 테스트 패턴 (Prior Art)**:
  - 기존 워크스페이스 파일시스템·검색 서비스·세션 IPC·프리로드 브리지 테스트의 임시 디렉터리 및 가짜 `ipcMain` 패턴
  - 기존 `<App />` 통합 및 멀티윈도우 테스트의 인메모리 워크스페이스·공유 **문서 버퍼**·창 코디네이터 `WikiApi` 하네스 패턴
  - 기존 **Git 패널** 아코디언·**섹션 리사이저** 및 `<DocumentEditor />` 4개 **에디터 모드**·**문서 목차**·**문서 내 찾기 바**·검색 점프 테스트 패턴

## Out of Scope (범위 제외 사항)

- 저장된 필터 프리셋(Saved Filters)의 `.wiki-editor/frontmatter.json` 또는 `workspace-state.json` 영속 저장 (1차 범위는 세션 비영속)
- 중앙 **편집 공간**의 Jira 이슈 테이블·칸반 보드형 전용 가상 탭 뷰 또는 **폴더 트리** 필터링
- 단일 검색 입력칸 내 텍스트 기반 쿼리 문법 파싱(예: `status:in-progress AND labels:backend`) 및 JQL 전환
- `url` 및 `doc-link`(워크스페이스 내 다른 마크다운 문서 참조 관계) 필드 타입 및 역링크 그래프
- 워크스페이스 스키마 없이 문서별 임의 키를 자유 생성·편집하는 자유 스키마 모드
- 서로 다른 필드 조건 간의 중첩 OR 논리 그룹 빌더
- 다중 선택된 여러 문서의 프론트매터를 한 번에 일괄 수정(Bulk Edit)하는 기능

## Further Notes (기타 참고사항)

- **보안 및 격리**: `.wiki-editor/frontmatter.json` 입출력과 워크스페이스 프론트매터 스캔은 기존 경로 보안 불변식(워크스페이스 루트 내부 제한, 탈출·순환 심볼릭 링크 차단)과 다중 **메인 창** 세션 격리를 반드시 유지합니다.
- **성능 및 반응성**: 워크스페이스 프론트매터 필터링과 커스텀 값 수집은 제한된 동시성과 `AbortSignal` 취소로 메인 프로세스 이벤트 루프 블로킹을 방지하고, 대용량(`2MB` 초과)·바이너리·`.wiki-editor/` 경로를 조기 스킵합니다.
- **개발 원칙**: `GEMINI.md`의 Red-Green-Refactor TDD 규칙과 테스트 격리 원칙을 준수하며, 모든 티켓 완료 시 `npm run typecheck`, `npm test`, `npm run build`를 검증합니다.
