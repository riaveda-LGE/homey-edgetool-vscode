package lib

// Handler는 모든 핸들러가 구현해야 하는 인터페이스입니다
type Handler interface {
	Execute(cm *ConnectionManager, args string) error
	Cleanup()
}

// BaseHandler는 공통 핸들러 기능을 제공하는 기본 구조체입니다
type BaseHandler struct{}

// Cleanup은 BaseHandler의 기본 리소스 정리 메서드입니다
func (bh *BaseHandler) Cleanup() {
	// 기본 구현은 아무것도 하지 않음
	// 각 핸들러에서 필요에 따라 오버라이드 가능
}
