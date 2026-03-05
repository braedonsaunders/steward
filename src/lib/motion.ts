import type { Transition, Variants } from "framer-motion";

export const smoothSpring: Transition = {
  type: "spring",
  stiffness: 180,
  damping: 24,
  mass: 0.9,
};

export const quickSpring: Transition = {
  type: "spring",
  stiffness: 320,
  damping: 28,
  mass: 0.72,
};

export const pageVariants: Variants = {
  initial: {
    opacity: 0,
    y: 10,
    scale: 0.997,
    filter: "blur(8px)",
  },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: {
      opacity: { duration: 0.16, ease: [0.22, 1, 0.36, 1] },
      y: smoothSpring,
      scale: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
      filter: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
    },
  },
  exit: {
    opacity: 0,
    y: 0,
    scale: 1,
    filter: "blur(2px)",
    transition: {
      duration: 0.1,
      ease: [0.4, 0, 1, 1],
    },
  },
};

export const staggerContainerVariants: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.04,
    },
  },
};

export const fadeUpItemVariants: Variants = {
  initial: { opacity: 0, y: 12 },
  animate: {
    opacity: 1,
    y: 0,
    transition: smoothSpring,
  },
};

export const navItemVariants: Variants = {
  initial: { opacity: 0, x: -10 },
  animate: {
    opacity: 1,
    x: 0,
    transition: {
      duration: 0.24,
      ease: [0.22, 1, 0.36, 1],
    },
  },
};
