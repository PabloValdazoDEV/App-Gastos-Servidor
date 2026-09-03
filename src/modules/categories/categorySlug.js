const COMBINING_MARKS = /[\u0300-\u036f]/g;
const INVALID_SLUG_CHARACTERS = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

export const createCategorySlug = (name) =>
  name
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(INVALID_SLUG_CHARACTERS, '-')
    .replace(EDGE_DASHES, '')
    .slice(0, 100);

