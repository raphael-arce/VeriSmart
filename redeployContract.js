const Web3 = require("web3");
const createB = require('./createBytecode.js');
const contractFunc = require('./getContract.js');
const exec = require('child_process').execSync;
const fs = require("fs");
const rlp = require('rlp');
const keccak = require('keccak');

const portContract = (contract_address,
                      source_rpc,
                      target_rpc,
                      target_address,
                      {deployment_tx_hash,
                      csv_path,
                      node,
                      fat_db,
                      targetFile}) => {

    const source_web3 = new Web3(source_rpc);
    return contractFunc.getContract(contract_address, source_web3, {deployment_tx_hash, csv_path, node, fat_db, targetFile}).then(async contract => {

        const web3 = new Web3(target_rpc);
        // Mapping of referenced contract addresses on old and new rpc
        let storage = contract.storage;
        let contract_code = contract.contract_code;
        let referenced_contract_addresses = {};
        //check if storage variable is a contract
        for (const [index, paddedValue] of Object.entries(storage)) {
            // remove leading zeros
            const value = paddedValue.replace(/^0+/, '');
            if (source_web3.utils.isAddress(value)) {
                console.log('Address found in Storage: ', value);
                // check if if it has been processed before
                if (value in referenced_contract_addresses) {
                    storage[index] = referenced_contract_addresses[value];
                } else {
                    const code = await source_web3.eth.getCode(value);
                    console.log('Code: ', code);
                    console.log('Length: ', code.length);
                    // Externally owned accounts return 0x or 0x0
                    // Contracts return entire code, i.e. > 3
                    if (code.length > 3) {
                        console.log('--- Reference found in state, migrating: ', value, ' ---');
                        const address = await portContract("0x" + value, source_rpc, target_rpc, target_address);
                        const contractAddress = address.substring(2);
                        console.log('contract address: ,', contractAddress);
                        const paddingValue = "000000000000000000000000";
                        const paddedAddress = paddingValue + contractAddress;
                        console.log('padded address: ,', paddedAddress);
                        referenced_contract_addresses[value] = paddedAddress;

                        storage[index] = paddedAddress;
                    }
                }
            }
        }

        // remove http://
        const mythril_rpc = source_rpc.replace(/(^\w+:|^)\/\//, '');

        // call mythrill to receive referenced contracts
        // log is written to stderr, forward to stdout and pipe to grep
        // use grep's perl regex as ES2017 doesn't support lookbehind regexes
        const command =
            'myth --rpc ' +
            mythril_rpc +
            ' -xa ' +
            contract_address +
            ' -l --max-depth 8 -v1 2>&1 >/dev/null | ' +
            'grep -oP \'(?<=INFO:root:Dependency address: ).*$\'';
        console.log('command: ', command);
        let execution_result = '';
        try {
            let stdout = exec(command);
            execution_result = stdout.toString('utf8');
            console.log('STD: ', execution_result);
        } catch (ex) {
            console.log('No dependency found');
        }
        let referencedContracts = Array.from(new Set(execution_result.split(/\r\n|\r|\n/g)));
        referencedContracts.pop();

        console.log('Referenced contracts: ', referencedContracts);
        for (const contract of referencedContracts) {
            // Currently, state dependencies are obeserved as well
            // However, they should not be taken care of here
            const value = contract.substring(2).replace(/^0+/, '');
            console.log('Value: ',value);
            if (!(value in referenced_contract_addresses)) {
                console.log('--- Reference found in bytecode, migrating: ', contract, ' ---');
                const receipt = await portContract(contract, source_rpc, target_rpc, target_address);
                const contractAddress = (receipt._address + "").substring(2);
                console.log('Replacing ', contract.substring(2), ' with ', contractAddress);
                const regex = new RegExp(contract.substring(2));
                contract_code.replace(regex, contractAddress);
            }
        }
        // TODO: Clean up this mess
        let deploy_code = "0x" + createB.createBytecode(contract_code, storage);
        // TODO: Should calculate proper gas requirement for executing code
        console.log('Length', deploy_code.length);
        if (deploy_code.length < 1000) {
            return await deployLogic(web3, target_address, deploy_code);
        } else {
            return await deployLargeContract(web3, target_address, contract_code, storage);
        }
    });
};

const deployLargeContract = async (web3, target_address, contract_code, contract_state) => {
    //
    // Deploy Logic Contract
    //
    const deploy_code = "0x" + createB.createBytecode(contract_code, {});
    const logicContractAddress = await deployLogic(web3, target_address, deploy_code);
    //
    // Deploy ProxyContract
    //
    const proxyJsonRaw = fs.readFileSync("./contracts/ProxyContract.json");
    const proxyJson = JSON.parse(proxyJsonRaw);
    let proxyCode = proxyJson.bytecode;
    // Replace placeholder address with logic contract address
    proxyCode = proxyCode.replace('2222222222222222222222222222222222222222', logicContractAddress.substring(2));
    // Calculate address of initialization contract and insert into proxy
    const currentNonce = await web3.eth.getTransactionCount(target_address);
    const calculatedInitContractAddress = calculateContractAddress(currentNonce + 1, target_address);
    proxyCode = proxyCode.replace('8888888888888888888888888888888888888888', calculatedInitContractAddress);
    const proxyContract = new web3.eth.Contract([]);
    let proxyAddress;
    console.log('--- Deploy Proxy ---');
    console.log('Proxy bytecode: ', proxyCode);
    const proxyDeployed = await proxyContract.deploy({data: proxyCode}).send({
        from: target_address,
        gas: 4700000,
        gasPrice: '2000000000'
    })
        .on('error', function (error) {
            console.log('Error: ', error)
        })
        .on('transactionHash', function (transactionHash) {
            console.log('TxHash: ', transactionHash)
        })
        .on('receipt', function (receipt) {
            proxyAddress = receipt.contractAddress;
            console.log('Proxy Contract: ', receipt.contractAddress); // contains the new contract address
            return receipt;
        });

    //
    // Deploy Initialization Contract
    //
    const initJsonRaw = fs.readFileSync("./contracts/InitContract.json");
    const initJson = JSON.parse(initJsonRaw);
    let initCode = initJson.bytecode;
    let initAbi = initJson.abi;
    // Replace placeholder address with logic contract address
    initCode = initCode.replace('2222222222222222222222222222222222222222', proxyAddress.substring(2));
    const initContract = new web3.eth.Contract(initAbi);
    console.log('--- Deploy Init Contract ---');
    console.log('Proxy bytecode: ', initCode);
    let initContractAddress;
    const initInstance = await initContract.deploy({data: initCode}).send({
        from: target_address,
        gas: 4700000,
        gasPrice: '2000000000'
    })
        .on('error', function (error) {
            console.log('Error: ', error)
        })
        .on('transactionHash', function (transactionHash) {
            console.log('TxHash: ', transactionHash)
        })
        .on('receipt', function (receipt) {
            initContractAddress = receipt.contractAddress;
            console.log('Init address: ', receipt.contractAddress); // contains the new contract address
            return receipt;
        });

    initInstance.options.address = initContractAddress;
    // Set storage
    const storageKeys = Object.keys(contract_state);
    let keys = [];
    let values = [];
    for(let i = 0; i < storageKeys.length; i++) {
        const key  = storageKeys[i];
        keys.push('0x' + key);
        values.push('0x' + contract_state[key]);
        if(((i+1) % 40) == 0) {
            await setValuesOnInitContract(target_address, initInstance, keys, values);
            keys = [];
            values = [];
        }
    }
    await setValuesOnInitContract(target_address, initInstance, keys, values);
    return proxyAddress;

};

const setValuesOnInitContract = async (target_address, initContract, keys, values) => {
    console.log('keys: ', keys);
    console.log('values: ', values);
    await initContract.methods.setValue(keys, values).send({
        from: target_address,
        gas: 4700000,
        gasPrice: '2000000000'
    })
        .on('error', function (error) {
            console.log('Error: ', error)
        })
        .on('transactionHash', function (transactionHash) {
            console.log('TxHash: ', transactionHash)
        })
        .on('receipt', function (receipt) {
            console.log('Added storage values'); // contains the new contract address
            console.log('Receipt: ', receipt);
            return receipt;
        });
};

const deployLogic = async (web3, target_address, deploy_code) => {
    console.log('--- Deploy Logic ---');
    console.log('Deploy code: ', deploy_code);
    let myContract = new web3.eth.Contract([]);
    let contractAddress;
    await myContract.deploy({data: deploy_code}).send({
        from: target_address,
        gas: 4700000,
        gasPrice: '2000000000'
    })
        .on('error', function (error) {
            console.log('Error: ', error)
        })
        .on('transactionHash', function (transactionHash) {
            console.log('TxHash: ', transactionHash)
        })
        .on('receipt', function (receipt) {
            contractAddress = receipt.contractAddress;
            console.log('Logic Contract: ', contractAddress); // contains the new contract address
        });
    return contractAddress;
};

const calculateContractAddress = (nonce, target_address) => {
    const input_arr = [target_address, nonce];
    const rlp_encoded = rlp.encode(input_arr);
    let contract_address = keccak('keccak256').update(rlp_encoded).digest('hex');
    contract_address = contract_address.substring(24);
    console.log("Calculated Contract address: " + contract_address);
    return contract_address;
};

module.exports.portContract = portContract;
