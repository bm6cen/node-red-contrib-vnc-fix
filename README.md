# node-red-contrib-vnc
Node-red node allowing control of a VNC Server

*N.B. This has been thrown together for a personal project and it's most-likely not efficent and doesn't have much error handling! I have released it as I cannot find VNC nodes elsewhere so it may be useful to others for similar purposes. I will try to release updates when time permits*

##預期效果 20260807 fix by ai
* 連線在伺服器逾時或網路短暫中斷時，會被正確偵測並自動重新連線（在下一次執行 perform 時）。  
* 節點狀態圖示會即時反映真實的連線狀況（綠＝連線中，黃＝連線中，紅＝錯誤/斷線）。  
* screenshot 節點不再因字串轉義錯誤而無法載入，且在客戶端或 RFB 實例缺失時會給出明確錯誤訊息。  
* 長時間運行後，不再需要手動斷線再連線才能擷取畫面。


## Current Nodes
* **vnc-client** - Configuration node containing server details
* **info** - Gets server info (name, height and width)
* **keyboard** - Allows sending of key presses or strings to the remote server
* **mouse** - Allows sending of mouse movememnts and button presses to the remote server
* **clipboard** - Allows sending or receiving of clipboard to/from the remote server
* **screenshot** - Returns a screenshot from the remote server as a PNG buffer

## To-Do
* Change credentials to use Node's credentials functions
* Example flows to follow

## Pre-requesites
None!

## Credits
* **node-rfb2** - https://github.com/sidorares/node-rfb2
* **JIMP** - https://github.com/oliver-moran/jimp
