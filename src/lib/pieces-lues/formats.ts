/**
 * CE QUE LE LECTEUR DE PIÈCES LIT — formats, taille, pages. Module PUR, sans import : le sélecteur de fichier d'un
 * écran (composant client) le lit aussi, et le service (`service.ts`) le réexporte pour le serveur. Le serveur
 * revérifie TOUJOURS : le filtre du sélecteur évite un aller-retour, il ne garde rien.
 */

/** Les formats lus : ceux qui portent un texte natif, et ceux que l'OCR de ce serveur sait lire. */
export const FORMATS_LUS = ["pdf", "png", "jpg", "jpeg", "webp", "tif", "tiff", "docx", "xlsx", "xls"] as const;
/**
 * Au-delà, une pièce n'est pas lue — une limite OPÉRATIONNELLE (§118.2) : l'OCR tourne sur ce serveur,
 * dans l'action qui attend sa réponse, et un scan de cette taille n'est plus une pièce commerciale.
 */
export const TAILLE_MAX_OCTETS = 15 * 1024 * 1024;
/** L'OCR ne lit pas au-delà de dix pages (décision 2) — et le dit, pages lues sur pages totales. */
export const PAGES_MAX = 10;
/** Pour l'attribut `accept` d'un `<input type="file">`. */
export const ACCEPT_PIECES = FORMATS_LUS.map((f) => `.${f}`).join(",");
