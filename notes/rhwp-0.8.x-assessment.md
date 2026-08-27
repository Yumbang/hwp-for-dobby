# rhwp 0.8.4 점검 — 2026-08-27

핀은 **0.7.19**, 최신은 **0.8.4** (0.8.0~0.8.4, 5개 뒤).
릴리즈 노트는 고수준이라 우리 질문에 답하지 않으므로 **직접 시험했다**(스크래치 설치,
레포 핀 미변경). 모든 판정은 export→reload를 거친 **디스크 확인**이다.

## API 표면

| | |
|---|---|
| 0.7.19 메서드 | 338 |
| 0.8.4 메서드 | **417** |
| 신규 | **79** |
| **제거** | **0 — 파괴 변경 없음** |

## 재측정 조건 — 하나가 바뀌었다

`notes/parallel-editing-options.md`에 적어둔 세 조건과, 규칙 60·61의 제약을 그대로 시험했다.

| 항목 | 0.7.19 | 0.8.4 |
|---|---|---|
| **`setCharShapeId`** | 무동작 (전 id) | ✅ **동작한다** |
| `applyCharFormat({fontFamily})` | 무동작 | ✗ 여전히 무동작 |
| `createStyle` charProps | 무시 | ✗ 여전히 무시 |
| `updateStyle` | `true` 반환, 무변화 | ✗ 여전히 무변화 |
| `updateStyleShapes` | WASM 힙 크래시 | ✗ **여전히 크래시** |
| `setColumnDef` columnCount | 안 바뀜 | ✗ 여전히 안 바뀜 |
| 문서 간 클립보드 | 인스턴스별 | 미시험 |

실측(0.8.4, `fixture-headings.hwp` 문단 6):
```
setCharShapeId(0,6,0,5,1)  ->  디스크: charShapeId 0→1, 글꼴 함초롬바탕→함초롬돋움
```

**의미:** 규칙 60의 "글꼴은 문서에 이미 있는 스타일로만 바꿀 수 있다"가 넓어진다.
스타일이 아니라 **문서의 charShape 표 전체**가 대상이 되므로, 스타일이 싣고 있지 않은
글꼴에도 도달할 수 있다. 다만 **임의의 글꼴은 여전히 불가**다 — 문서에 없는 글꼴을
만들 방법(`createStyle`/`updateStyle`)은 그대로 막혀 있다.

도달 범위는 재봤으나 **정확한 수치가 아니다**: charShape id를 0~39만 훑어서 실문서
8건에서 55%가 나왔는데, 이는 **하한**이다(문서가 40개 넘는 charShape을 가질 수 있다).
확정하려면 `getCharShapeSet`으로 표 크기를 먼저 읽어야 한다.

## 눈에 띄는 신규 API

우리가 손으로 만든 것과 겹치는 것들:

| API | 우리 쪽 대응 | 확인 |
|---|---|---|
| `getCharShapeSet` / `getParaShapeSet` / `getCellShapeSet` | `lib/palette.mjs`가 문단마다 4.2회 호출로 수집 | ✅ 동작 — 원시 HWP 필드명(`FaceNameHangul`, `RatioHangul`, …)으로 **언어별 슬롯 7개를 그대로** 준다 |
| `getControls(s,p)` | `lib/doc_walk.mjs`의 열거-후-프로브 | ✅ 동작 — `ctrlId`/`userDesc`로 **타입을 직접** 준다(`secd`=구역 정의, `cold`=단 정의). 규칙 7의 프로브가 불필요해질 수 있다 |
| `contentLoss` | `assertMemoSafe` / `assertTrackChangeSafe` | ⚠️ 문서 메서드가 아님 — `DocumentExport` 쪽으로 보인다. **확인 필요** |
| `exportHwpWithReport` / `exportHwpVerify` | `lib/verify.mjs` | 미시험 |
| `attachCaptionAt` / `detachCaptionAt` | `core/image.mjs`의 캡션 처리 | 미시험 |
| `getSourceImageBytes` / `getPageSourceImageKeys` | `lib/objects.mjs` | 미시험 |
| `getObjects` | `lib/objects.mjs` | 빈 배열 반환(이 픽스처엔 객체 없음) — 재시험 필요 |
| `splitTable` / `mergeTableWithNext` / `renameField` | 없음 | 신규 기능 |

`getCharShapeSet`과 `getControls`가 특히 크다. 전자는 팔레트가 문단마다 하는 일을
표 한 번 읽기로 대체할 수 있고, 후자는 **규칙 7**(`findNearestControl*`은 열거자가
아니므로 프로브로 분류해야 한다)의 전제를 바꾼다.

`contentLoss`는 사실이면 가장 크다 — 메모·변경추적이 모델링되지 않아 우리가 세운
가드(699줄, 규칙 4·5)를 엔진이 대신 답해줄 수 있다.

## 릴리즈 노트에서 우리와 관련 있는 항목

- **0.8.0** "Save fidelity overhaul — HWPX 속성(secPr, tables, borders, images, fields)
  왕복 보존 수정" → **규칙 70**(HWPX→HWP 변환 시 빈 문단 추가)이 사라졌을 수 있다. 재시험 대상.
- **0.8.1** "Style editing now recorded in history" → 위 실측대로 스타일 *정의*는 여전히 안 된다.
- **0.8.3** 암호화 문서 호환(HWP5 EncryptVersion 4, HWP3, 암호화 HWPX), 중첩 표 레이아웃 개선.

## 권고

**범프할 가치가 있다. 단 별도 작업으로.** 근거:

1. **파괴 변경 0** — 표면이 늘기만 했다
2. `setCharShapeId`가 우리 문서화된 제약 하나를 실제로 푼다
3. `getCharShapeSet`·`getControls`가 우리 코드를 **줄일** 여지가 있다
4. HWPX 저장 충실도 개선이 규칙 70을 무효화할 수 있다

**하지 말아야 할 것:** 이번 세션에서 바로 범프. `npm run bump`는 전 스위트가 그린이어야
통과하는데, 620개 테스트 중 **엔진 동작을 고정한 것들**(규칙 54·59~70)이 0.8.4에서
어떻게 되는지 모른다. 최소 한 건(`setCharShapeId` 무동작을 단정한 규칙 60/61 관련)은
**의도적으로 빨개져야 맞다** — 그건 회귀가 아니라 사실 변경이므로 규칙과 테스트를
같이 고쳐야 한다.

범프 시 순서:
1. `npm run bump 0.8.4` → 어떤 테스트가 빨개지는지 **읽는다**
2. 빨개진 것마다 "엔진이 고쳐진 것"인지 "우리가 깨진 것"인지 판별
3. 전자는 spec 규칙 + 테스트를 갱신, 후자는 코드 수정
4. `contentLoss` / `getCharShapeSet` / `getControls`는 **범프 후 별도 작업**으로 평가
