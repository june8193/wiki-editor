# 03 — 멀티 탭 및 좌/우(상/하) 2분할 Split View 레이아웃 (비활성 탭 경량화)

Spec: [spec.md](../spec.md)
Type: task
Blocked by: 02-workspace-folder-tree-and-favorites
Status: ready-for-agent

**What to build:**
웹 브라우저처럼 여러 문서를 다중 탭으로 열어 전환·닫기할 수 있고, 최대 2개 Pane(좌/우 또는 상/하 Split View) 각각에 독립된 탭 바와 활성 문서를 띄우며, 동일 문서를 두 Pane에서 동시에 열 때 실시간 버퍼가 동기화되고 비활성 탭은 DOM을 언마운트해 메모리를 경량화하는 레이아웃 시스템을 구축합니다.

## Acceptance Criteria

- [ ] 중앙 문서 버퍼 스토어(`DocumentBufferStore`)가 정규화된 파일 경로를 기준으로 본문, `isDirty` 상태, 버전을 관리하며, 동일한 파일을 Primary/Secondary 두 Pane에 동시에 열어도 한쪽 편집 시 반대쪽이 즉시 동기화됩니다.
- [ ] 각 Pane(`primary`, `secondary`)은 독립된 탭 바(탭 열기, 클릭 전환, 가운데 클릭/`X` 닫기, 미저장 파일 닫기 시 저장 확인 프롬프트, 좌/우 드래그 또는 컨텍스트 메뉴 "분할 영역으로 이동/복제 열기")를 제공합니다.
- [ ] Split View 컨트롤로 단일 Pane ↔ 좌/우 2분할(`horizontal`) ↔ 상/하 2분할(`vertical`) 전환과 분할 경계선 리사이즈가 가능하며, 보조 Pane의 모든 탭을 닫으면 자동으로 단일 Pane으로 복귀합니다.
- [ ] **비활성 탭 경량화 불변식**: 탭을 20개 이상 열더라도 화면에 보이는 각 Pane의 활성 탭(`activeTabId`, 최대 2개)만 에디터 뷰 컴포넌트를 마운트하며, 비활성 탭은 커서 위치·스크롤 오프셋·모드 상태만 스토어에 보관합니다(DOM 미마운트 검증 테스트 포함).
- [ ] 상태 스토어 및 React Testing Library 기반 탭/분할/동기화/언마운트 검증 테스트가 모두 통과합니다.
