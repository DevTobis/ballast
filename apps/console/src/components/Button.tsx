import type { ButtonHTMLAttributes } from "react";

export function Button({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "danger" }) {
  const base =
    "border px-3 py-1.5 text-xs uppercase tracking-[0.1em] transition-transform active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed";
  const variants = {
    default: "border-fg text-fg hover:bg-fg hover:text-bg",
    danger: "border-accent text-accent hover:bg-accent hover:text-bg",
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}
