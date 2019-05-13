# mini-zabbix
Allow monitor status and trigger actions like Zabbix

## Install
```bash
npm i -g mini-zabbix@latest
```

## config file
Configuration file keep also status and history.
Example with comments (note: comments are not allowed in JSON file):
```json
{
  "items": [
    { // variable for current version of some application
      "name": "app.current.version", // name of variable 
      "cmd": "command -v", // command tro retrieve current version application
      "history": 5, // how many records (values) are keep in history
      "lastValues": [] // history of command values
      ]
    },
    { // other variable checking available version
      "name": "app.available.version",
      // command can be complicated like:
      "cmd": "curl -s https://api.github.com/repos/profiprog/email-process-output/tags | node -e \"console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))[0].name.replace(/^v/,''));\"",
      "history": 5,
      "lastValues": []
    } 
  ],
  "triggers": [
    {
      "name": "New version of app is available",
      "expression": [
        "{item:gitlab.current.version} !== {item:gitlab.available.version} && ",
        "{item:gitlab.current.version.is_same(#3)} && {item:gitlab.available.version.is_same(#3)}"
      ],
      "status": "down",
      "up-actions": [
        {
          "type": "shell",
          "command": [
            "$HOME/update",
          ],
          "lastExecution": {} // will contains details of last execution
        }
      ],
      "down-actions": [],
      "error-actions": [ // contains action which triggers when any up-action or down-action fails
        {
          "type": "mail",
          "username": "xyz@gmail.com",
          "password": "s3cr3t!",
          "subject": "[cron:{whoami}@{hostname}] {trigger:name}",
          "bodyType": "plain",
          "body": [
            "Current version: {item:app.current.version}",
            "Available version: {item:app.available.version}",
            "Autoupdatig update fails: $ ~/update"
          ]
        },
      ],
      "lastProcessingTime": "2019-05-13 03:33:02.831"
    }
  ]
}```

## Usage
1. get full path to `mini-zabbix`
	```bash
	which mini-zabbix
	```

1. add record to crontab
	```cron
	# m h  dom mon dow   command
	0 1 * * * /full/path/to/mini-zabix /full/path/to/config.json
	
	```

### Run once
```bash
mini-zabbix config-file.json
```

### To-Do
 * JSON schema for validating config file
   
