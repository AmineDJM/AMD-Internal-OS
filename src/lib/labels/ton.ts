/**
 * Libellés — le TON des badges (`<Badge>`) et la forme d'un libellé à badge.
 * Module PUR, zéro import : lu par tous les morceaux de `labels/` et par les composants client.
 */

export type BadgeTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "purple";

export interface Display {
  label: string;
  tone: BadgeTone;
}
