import type {Route} from '../backend/types';

// A used-up exit carries a stamp with the time it is valid again.
const utc=(t:number)=>new Date(t).toISOString().slice(11,16)+' UTC';
export const usedUp=(r?:Route)=>!!r?.exhaustedUntil&&r.exhaustedUntil>Date.now();

export function Stamp({until,refused}:{until:number;refused?:boolean}){
  return <div className="stamp" role="img" aria-label={refused?`Refused by the Free tier until ${utc(until)}`:`Used up, valid again at ${utc(until)}`}>{refused?'REFUSED':'USED UP'}<small>VALID AGAIN {utc(until)}</small></div>;
}
