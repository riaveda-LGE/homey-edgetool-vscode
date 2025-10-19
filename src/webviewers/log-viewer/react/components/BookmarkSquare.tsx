type Props = {
  checked?: boolean;
  size?: number; // px
  title?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** 시각 톤: 그리드(기본) / 북마크 패널 */
  variant?: 'grid' | 'panel';
};

/**
 * 공통 별 사각형 버튼
 * - hover: 배경만 어둡게(검정)
 * - active: 별 채움(white)
 * - checked: ★ / unchecked: ☆
 * - 크기는 size로 지정(미지정 시 24px)
 */
export function BookmarkSquare({
  checked = false,
  size = 24,
  title,
  onClick,
  variant = 'grid',
}: Props) {
  // 버튼 대비 별 아이콘 비율(작게 → 시각적 중심 안정)
  const icon = Math.max(10, Math.round(size * 0.54));
  return (
    <button
      type="button"
      title={title}
      aria-pressed={checked}
      data-checked={checked ? 1 : 0}
      className={`lv-bm-btn ${variant === 'panel' ? 'lv-bm--panel' : 'lv-bm--grid'}`}
      style={{ width: size, height: size }}
      onClick={onClick}
    >
      {/*
        SVG(24x24)를 절대 중심으로 배치.
        - 색상은 currentColor → CSS에서 상태별로 제어
        - checked: 채움(fill), unchecked: 얇은 윤곽선(stroke=1.2)
        - 약간의 상향 보정(transform)으로 시각적 중앙 정렬
      */}
      <svg
        className="lv-bm-star"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={icon}
        height={icon}
        aria-hidden="true"
        focusable="false"
      >
        <g transform="translate(0,-0.3)">
          {checked ? (
            <path
              d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
              fill="currentColor"
            />
          ) : (
            <path
              d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </g>
      </svg>
    </button>
  );
}
