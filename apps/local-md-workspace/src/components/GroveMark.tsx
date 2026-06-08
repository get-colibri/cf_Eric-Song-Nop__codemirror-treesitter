import groveMarkUrl from "@/assets/brand/grove-mark.svg";
import { cn } from "@/lib/utils";

type GroveMarkProps = {
  className?: string;
  decorative?: boolean;
};

export function GroveMark({ className, decorative = false }: GroveMarkProps) {
  return (
    <img
      className={cn("block size-8 shrink-0 object-contain", className)}
      src={groveMarkUrl}
      alt={decorative ? "" : "Grove"}
      aria-hidden={decorative || undefined}
      draggable={false}
    />
  );
}
