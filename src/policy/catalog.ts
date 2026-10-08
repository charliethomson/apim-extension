import data from '../../data/policies.json';
import { Catalog, type PolicyFile } from './schema';

/** The bundled policy catalog from data/policies.json. */
export const catalog = new Catalog(data as PolicyFile);
