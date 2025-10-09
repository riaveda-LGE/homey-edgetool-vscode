package util

import (
	"fmt"
)

// ANSI 색상 코드 상수 정의
// ===== 색상 상수 정의 =====
// 색상 사용 원칙:
// 🔴 ColorRed: 에러/실패 상황 표시 (사용자 개입 필요)
// 🟢 ColorGreen: 성공/완료 상태 표시
// 🟡 ColorYellow: 경고/주의/진행중 상태 표시
// 🔵 ColorCyan: 일반 정보/명령어 출력
// 🟢 ColorBrightGreen: 중요한 성공/프롬프트 강조
// 🔵 ColorBrightCyan: 진행률/단계/디버깅 정보 표시
// ⚪ ColorReset: 색상 초기화 (항상 로그 끝에 사용)
const (
	ColorReset     = "\033[0m"       // ⚪ 색상 초기화
	ColorBlack     = "\033[30m"      // ⚫ 검정
	ColorRed       = "\033[31m"      // 🔴 빨강 (에러 표시)
	ColorGreen     = "\033[32m"      // 🟢 초록 (성공 표시)
	ColorYellow    = "\033[33m"      // 🟡 노랑 (경고 표시)
	ColorBlue      = "\033[34m"      // 🔵 파랑
	ColorMagenta   = "\033[35m"      // 🟣 마젠타
	ColorCyan      = "\033[36m"      // 🔵 청록 (정보 표시)
	ColorWhite     = "\033[37m"      // ⚪ 흰색
	ColorBrightBlack   = "\033[90m"  // ⚫ 밝은 검정
	ColorBrightRed     = "\033[91m"  // 🔴 밝은 빨강
	ColorBrightGreen   = "\033[92m"  // 🟢 밝은 초록 (프롬프트)
	ColorBrightYellow  = "\033[93m"  // 🟡 밝은 노랑
	ColorBrightBlue    = "\033[94m"  // 🔵 밝은 파랑
	ColorBrightMagenta = "\033[95m"  // 🟣 밝은 마젠타
	ColorBrightCyan    = "\033[96m"  // 🔵 밝은 청록 (진행률)
	ColorBrightWhite   = "\033[97m"  // ⚪ 밝은 흰색
	ColorGray          = "\033[90m"  // ⚪ 회색
	ColorOrange        = "\033[38;5;208m" // 🟠 주황
	ColorPink          = "\033[38;5;205m" // 🩷 분홍
	ColorPurple        = "\033[38;5;93m"  // 🟣 보라
	ColorTeal          = "\033[38;5;30m"  // 🔵 틸
	ColorLime          = "\033[38;5;118m" // 🟢 라임
	ColorBrown         = "\033[38;5;94m"  // 🟤 갈색
	ColorNavy          = "\033[38;5;18m"  // 🔵 네이비
	ColorMaroon        = "\033[38;5;52m"  // 🟤 마룬
	ColorOlive         = "\033[38;5;58m"  // 🟡 올리브
)

// 색상 코드 리스트 (판단용)
var colorCodes = []string{
	ColorReset, ColorBlack, ColorRed, ColorGreen, ColorYellow, ColorBlue,
	ColorMagenta, ColorCyan, ColorWhite, ColorBrightBlack, ColorBrightRed,
	ColorBrightGreen, ColorBrightYellow, ColorBrightBlue, ColorBrightMagenta,
	ColorBrightCyan, ColorBrightWhite, ColorGray, ColorOrange, ColorPink,
	ColorPurple, ColorTeal, ColorLime, ColorBrown, ColorNavy, ColorMaroon, ColorOlive,
}

// isColorCode: 첫 번째 인자가 색상 코드인지 확인
func isColorCode(s string) bool {
	for _, code := range colorCodes {
		if code == s {
			return true
		}
	}
	return false
}

// Log 함수: 첫 번째 인자가 색상 코드면 색상 적용, 아니면 기본 출력
func Log(args ...interface{}) {
	if len(args) == 0 {
		return
	}

	first := args[0]
	if str, ok := first.(string); ok && isColorCode(str) {
		// 색상 적용
		fmt.Print(str)
		if len(args) > 1 {
			if fmtStr, ok := args[1].(string); ok {
				// fmt.Sprintf로 먼저 포맷팅 후 출력 (보안 정책 준수)
				result := fmt.Sprintf(fmtStr, args[2:]...)
				fmt.Print(result)
			} else {
				// format이 아니면 일반 출력
				fmt.Printf("%v", args[1])
				for _, arg := range args[2:] {
					fmt.Printf(" %v", arg)
				}
				fmt.Println()
			}
		}
		fmt.Print(ColorReset)
	} else {
		// 기본 출력
		if str, ok := first.(string); ok {
			fmt.Printf(str, args[1:]...)
		} else {
			// 첫 번째가 string이 아니면 일반 출력
			fmt.Printf("%v", first)
			for _, arg := range args[1:] {
				fmt.Printf(" %v", arg)
			}
			fmt.Println()
		}
	}
}
