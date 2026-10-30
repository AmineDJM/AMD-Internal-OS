"use client";

import React, { useEffect, useState } from "react";
import { motion, useSpring, useMotionValue } from "framer-motion";

/**
 * CURSEUR LUMINESCENT INTERACTIF — Apple Glass & Motion Physics.
 *
 * 1. Mode Libre (sur le fond animé) :
 *    Une orbe de verre cristalline (28px) suit le curseur avec une physique de ressort
 *    naturelle (stiffness: 380, damping: 28).
 *
 * 2. Mode Contextuel (au survol des conteneurs de verre / chat / KPI) :
 *    L'orbe se métamorphose dynamiquement en un halo lumineux diffus d'arrière-plan
 *    (largeur 360px, flou 52px, opacité douce 0.28) qui rétro-éclaire subtilement le verre
 *    sans jamais gêner la lecture des chiffres ou du texte.
 */
export function LuminescentCursor() {
  const [isHoveringGlass, setIsHoveringGlass] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  const mouseX = useMotionValue(-100);
  const mouseY = useMotionValue(-100);

  // Physique de ressort fluide inspirée d'Apple HIG
  const springConfig = { stiffness: 380, damping: 28, mass: 0.6 };
  const cursorX = useSpring(mouseX, springConfig);
  const cursorY = useSpring(mouseY, springConfig);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      mouseX.set(e.clientX);
      mouseY.set(e.clientY);
      if (!isVisible) setIsVisible(true);

      // Détection contextuelle : le curseur survole-t-il un élément de verre ?
      const target = e.target as HTMLElement | null;
      const glassElement = target?.closest('[data-glass="true"]');
      setIsHoveringGlass(!!glassElement);
    };

    const handleMouseLeave = () => {
      setIsVisible(false);
    };

    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    document.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [mouseX, mouseY, isVisible]);

  if (!isVisible) return null;

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none fixed left-0 top-0 will-change-transform"
      style={{
        x: cursorX,
        y: cursorY,
        translateX: "-50%",
        translateY: "-50%",
        zIndex: isHoveringGlass ? 5 : 40,
      }}
      animate={{
        width: isHoveringGlass ? 360 : 32,
        height: isHoveringGlass ? 360 : 32,
        opacity: isHoveringGlass ? 0.28 : 0.85,
        filter: isHoveringGlass ? "blur(52px)" : "blur(0px)",
      }}
      transition={{
        type: "spring",
        stiffness: 260,
        damping: 24,
      }}
    >
      <div
        className={`h-full w-full rounded-full transition-all duration-300 ${
          isHoveringGlass
            ? "bg-gradient-to-tr from-cyan-400/80 via-blue-500/70 to-indigo-300/80"
            : "border border-white/80 bg-white/35 backdrop-blur-md shadow-[0_0_20px_rgba(255,255,255,0.6)]"
        }`}
      />
    </motion.div>
  );
}
