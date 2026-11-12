// The English dictionaries (Hunspell, from LibreOffice via wooorm/dictionaries), British and American.
// Kept in a chunk of their own: loaded the first time spelling is checked, not at start-up.
// (Imported by path: the packages only export their Node loader.)
import gbAff from '../../../../node_modules/dictionary-en-gb/index.aff?raw'
import gbDic from '../../../../node_modules/dictionary-en-gb/index.dic?raw'
import usAff from '../../../../node_modules/dictionary-en/index.aff?raw'
import usDic from '../../../../node_modules/dictionary-en/index.dic?raw'

export const DICTIONARIES = [
  { aff: gbAff, dic: gbDic },
  { aff: usAff, dic: usDic }
]
