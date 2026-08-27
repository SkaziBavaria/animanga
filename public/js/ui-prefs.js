const STORAGE_KEY = 'animanga-ui-prefs';

const LIBRARY_FILTERS = new Set(['active', 'continue', 'caughtup', 'notstarted', 'sequels', 'hidden-sequels', 'archived', 'all']);
const LIBRARY_SORTS = new Set(['new', 'recent', 'progress', 'az']);
const NAVS = new Set(['library', 'discover', 'settings']);

const DEFAULTS = {
  nav: 'library',
  libraryFilter: 'active',
  librarySort: 'new',
  libraryQuery: '',
  mangaLibraryFilter: 'active',
  mangaLibrarySort: 'new',
  mangaLibraryQuery: '',
};

function sanitize(prefs = {}) {
  return {
    nav: NAVS.has(prefs.nav) ? prefs.nav : DEFAULTS.nav,
    libraryFilter: LIBRARY_FILTERS.has(prefs.libraryFilter) ? prefs.libraryFilter : DEFAULTS.libraryFilter,
    librarySort: LIBRARY_SORTS.has(prefs.librarySort) ? prefs.librarySort : DEFAULTS.librarySort,
    libraryQuery: String(prefs.libraryQuery || ''),
    mangaLibraryFilter: LIBRARY_FILTERS.has(prefs.mangaLibraryFilter) ? prefs.mangaLibraryFilter : DEFAULTS.mangaLibraryFilter,
    mangaLibrarySort: LIBRARY_SORTS.has(prefs.mangaLibrarySort) ? prefs.mangaLibrarySort : DEFAULTS.mangaLibrarySort,
    mangaLibraryQuery: String(prefs.mangaLibraryQuery || ''),
  };
}

export function readUiPrefs() {
  try {
    return sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeUiPrefs(patch = {}) {
  const next = sanitize({ ...readUiPrefs(), ...patch });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function applyUiPrefsToState(state) {
  const prefs = readUiPrefs();
  state.activeSection = prefs.nav === 'discover' ? 'discover' : 'library';
  state.libraryFilter = prefs.libraryFilter;
  state.librarySort = prefs.librarySort;
  state.libraryQuery = prefs.libraryQuery;
  state.mangaLibraryFilter = prefs.mangaLibraryFilter;
  state.mangaLibrarySort = prefs.mangaLibrarySort;
  state.mangaLibraryQuery = prefs.mangaLibraryQuery;
  return prefs;
}

export function syncLibraryControls(els, state) {
  if (els.libraryFilter) els.libraryFilter.value = state.libraryFilter;
  if (els.librarySort) els.librarySort.value = state.librarySort;
  if (els.librarySearchInput) els.librarySearchInput.value = state.libraryQuery || '';
  if (els.mangaLibraryFilter) els.mangaLibraryFilter.value = state.mangaLibraryFilter;
  if (els.mangaLibrarySort) els.mangaLibrarySort.value = state.mangaLibrarySort;
  if (els.mangaLibrarySearchInput) els.mangaLibrarySearchInput.value = state.mangaLibraryQuery || '';
}
