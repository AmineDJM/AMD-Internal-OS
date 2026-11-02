# Charte graphique Adventum Pharma

Source : `docs/charte/charte-en-tete-adventum-pharma.pdf` (papier à en-tête A4 fourni par la Direction le 30/10/2026,
InDesign). Couleurs relevées dans le PDF vectoriel (`pdftocairo -svg`), logos rendus depuis le vectoriel à 600 dpi,
fond transparent.

## Logos (`public/adventum-ia/`)

| Fichier | Contenu | Taille |
|---|---|---|
| `logo-complet.png` | Marque + « ADVENTUM » + « PHARMA », fond transparent | 2525 × 541 |
| `logo-marque.png` | Les carrés seuls (symbole), fond transparent | 525 × 525 |
| `icone-180.png` | Icône iPhone (apple-touch-icon), symbole sur fond blanc | 180 × 180 |
| `icone-192.png`, `icone-512.png` | Icônes du manifeste PWA | 192, 512 |
| `icone-maskable-512.png` | Icône « maskable » (zone sûre 60 %) | 512 × 512 |

## Couleurs

| Jeton | Hex | Où dans la charte |
|---|---|---|
| `bleu-adventum` | `#2C59A7` | Bleu profond : bas du grand carré, bas des lettres « ADVENTUM » |
| `bleu-clair` | `#457AC6` | Haut des lettres et du grand carré (dégradé vertical vers `#2C59A7`) |
| `indigo` | `#324BA6` | Filet droit du pied de page, textes de contact |
| `sarcelle` | `#2B6E82` | « PHARMA », filet gauche du pied de page, libellés NIF/RC |
| `cyan` | `#57C8DD` | Départ du dégradé des petits carrés (vers `#2B6E82`) |

Dégradés : grand carré et lettres `#457AC6 → #2C59A7` ; petits carrés `#57C8DD → #2B6E82` (gauche → droite).

## Typographie

Le papier utilise **Helvetica Neue** (LT Std Roman et Bold). À l'écran : `"Helvetica Neue", Helvetica, Arial,
sans-serif` ; pour l'arabe, une police à script complexe (Noto Naskh Arabic / Noto Sans Arabic).

## Usage dans Adventum IA

- Couleur principale (boutons, liens, bulle de l'utilisateur, `theme_color` du manifeste) : `#2C59A7`.
- Accent secondaire (états, indicateurs, voix) : `#2B6E82` / `#57C8DD`.
- Thème sombre : éclaircir les bleus pour le contraste (ex. `#7FA6E3` pour le principal) ; garder les dégradés du logo.
- Ne pas déformer ni recolorer le logo ; marge libre autour du logo ≥ la hauteur d'un petit carré.
