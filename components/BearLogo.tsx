interface BearLogoProps {
  className?: string;
}

export function BearLogo({ className = "h-10 w-10" }: BearLogoProps) {
  return (
    <span
      className={`${className} inline-grid shrink-0 place-items-center rounded-xl bg-indigo-600 text-rose-200`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 48 48" fill="none" className="h-[78%] w-[78%]">
        <circle cx="14" cy="14" r="7" fill="currentColor" />
        <circle cx="34" cy="14" r="7" fill="currentColor" />
        <path
          d="M9 28c0-11 6-18 15-18s15 7 15 18v3c0 7-6 11-15 11S9 38 9 31v-3Z"
          fill="currentColor"
        />
        <ellipse cx="24" cy="31" rx="9" ry="7" fill="#E3E4E0" />
        <circle cx="18" cy="25" r="2" fill="#454A44" />
        <circle cx="30" cy="25" r="2" fill="#454A44" />
        <path d="m21 30 3-2 3 2-3 3-3-3Z" fill="#454A44" />
      </svg>
    </span>
  );
}
