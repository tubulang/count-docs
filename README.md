# how to use
## precondition
Pull all repositories into the same folder

## Normal npm project: 
- Statistics of the export API (including enumeration) through the main field of the package.json
- Need to build first

## MF project:
- Statistics are made by passing in the export file configuration with the --mf-exposes parameter

- The following repository can be executed with the corresponding command

## billing sdk
``` 
    node analyze.js ../sdks.am-static.com_aftership-billing-ui --mf-exposes '{ "./" : "./src/index.ts"}'
```

## comments
```
    node analyze.js ../comments
```

## auth sdk
```
    node analyze.js ../automizely-product-auth
```

## widget account
```
    node analyze.js ../widgets.am-static.com_accounts --mf-exposes '{ "./" : "./src/index.ts"}'
```

## widget platform 
```
    node analyze.js ../widgets.am-static.com_platform --mf-exposes '{ "./" : "./src/index.ts"}'
```