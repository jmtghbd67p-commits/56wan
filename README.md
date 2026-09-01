# 오육완 (56wan)

- 대표 웹앱: https://56wan.vercel.app
- 기존 주소: https://littletrip.vercel.app

## 필수 환경변수

- `NAVER_API_KEY_ID`, `NAVER_API_KEY_SECRET`: 장소 후보 검색
- `KAKAO_REST_KEY`: 차량 이동시간 계산
- `CULTURE_DATA_SERVICE_KEY`: 박물관·미술관·도서관의 현재 전시·교육·체험 제목 조회

`CULTURE_DATA_SERVICE_KEY`는 공공데이터포털에서 발급한 일반 인증키입니다. 문화시설 조회서비스뿐 아니라 **한눈에보는문화정보 조회서비스**도 활용신청해야 활성 전시 정보를 받을 수 있습니다. 키는 Vercel Environment Variables에만 저장합니다.
