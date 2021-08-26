/**
 * @version 0.52
 */
import BlocksoftCryptoLog from '@crypto/common/BlocksoftCryptoLog'
import BlocksoftUtils from '@crypto/common/BlocksoftUtils'
import BlocksoftExternalSettings from '@crypto/common/BlocksoftExternalSettings'
import BlocksoftBalances from '@crypto/actions/BlocksoftBalances/BlocksoftBalances'

// eslint-disable-next-line no-unused-vars
import { BlocksoftBlockchainTypes } from '@crypto/blockchains/BlocksoftBlockchainTypes'

import { PublicKey, SystemProgram, Transaction, StakeProgram, Authorized } from '@solana/web3.js/src/index'
import SolUtils from '@crypto/blockchains/sol/ext/SolUtils'
import config from '@app/config/config'
import SolTmpDS from '@crypto/blockchains/sol/stores/SolTmpDS'
import BlocksoftPrettyNumbers from '@crypto/common/BlocksoftPrettyNumbers'

export default class SolTransferProcessor implements BlocksoftBlockchainTypes.TransferProcessor {
    private _settings: { network: string; currencyCode: string }

    constructor(settings: { network: string; currencyCode: string }) {
        this._settings = settings
    }

    needPrivateForFee(): boolean {
        return false
    }

    checkSendAllModal(data: { currencyCode: any }): boolean {
        return false
    }

    async getFeeRate(data: BlocksoftBlockchainTypes.TransferData, privateData: BlocksoftBlockchainTypes.TransferPrivateData, additionalData: {} = {}): Promise<BlocksoftBlockchainTypes.FeeRateResult> {
        const result: BlocksoftBlockchainTypes.FeeRateResult = {
            selectedFeeIndex: -3,
            shouldShowFees: false
        } as BlocksoftBlockchainTypes.FeeRateResult

        const feeForTx = BlocksoftExternalSettings.getStatic('SOL_PRICE')
        result.fees = [
            {
                langMsg: 'xrp_speed_one',
                feeForTx,
                amountForTx: data.amount
            }
        ]
        result.selectedFeeIndex = 0


        return result
    }

    async getTransferAllBalance(data: BlocksoftBlockchainTypes.TransferData, privateData: BlocksoftBlockchainTypes.TransferPrivateData, additionalData: BlocksoftBlockchainTypes.TransferAdditionalData = {}): Promise<BlocksoftBlockchainTypes.TransferAllBalanceResult> {
        const balance = data.amount
        // @ts-ignore
        await BlocksoftCryptoLog.log(this._settings.currencyCode + ' SolTransferProcessor.getTransferAllBalance ', data.addressFrom + ' => ' + balance)

        const fees = await this.getFeeRate(data, privateData, additionalData)

        const amount = BlocksoftUtils.diff(balance, fees.fees[0].feeForTx).toString()

        return {
            ...fees,
            shouldShowFees: false,
            selectedTransferAllBalance: amount
        }
    }

    /**
     * @param data
     * @param privateData
     * @param uiData
     */
    async sendTx(data: BlocksoftBlockchainTypes.TransferData, privateData: BlocksoftBlockchainTypes.TransferPrivateData, uiData: BlocksoftBlockchainTypes.TransferUiData): Promise<BlocksoftBlockchainTypes.SendTxResult> {

        if (typeof privateData.privateKey === 'undefined') {
            throw new Error('SOL transaction required privateKey (derivedSeed)')
        }
        if (typeof data.addressTo === 'undefined') {
            throw new Error('SOL transaction required addressTo')
        }

        if (uiData && typeof uiData.uiErrorConfirmed !== 'undefined' &&
            (
                uiData.uiErrorConfirmed === 'UI_CONFIRM_ADDRESS_TO_EMPTY_BALANCE'
                || uiData.uiErrorConfirmed === 'UI_CONFIRM_DOUBLE_SEND'
            )
        ) {
            // do nothing
        } else if (data.addressTo !== 'STAKE' && data.addressTo.indexOf('UNSTAKE') === -1) {
            const balance = await (BlocksoftBalances.setCurrencyCode('SOL').setAddress(data.addressTo)).getBalance('SolSendTx')
            if (!balance || typeof balance.balance === 'undefined' || balance.balance === 0) {
                throw new Error('UI_CONFIRM_ADDRESS_TO_EMPTY_BALANCE')
            }
        }

        const tx = new Transaction()

        let seed, stakeAddress = false
        try {
            const fromPubkey = new PublicKey(data.addressFrom)
            if (data.addressTo.indexOf('UNSTAKE') === 0) {
                tx.add(StakeProgram.withdraw({
                    authorizedPubkey: fromPubkey,
                    stakePubkey: new PublicKey(data.blockchainData.stakeAddress),
                    lamports: data.amount * 1,
                    toPubkey: fromPubkey
                }))
                /*tx.add(StakeProgram.deactivate({
                    authorizedPubkey : fromPubkey,
                    stakePubkey : new PublicKey(data.blockchainData.stakeAddress),
                }));*/
            } else if (data.addressTo === 'STAKE') {

                const authorized = new Authorized(fromPubkey, fromPubkey)

                // https://github.com/velas/JsWallet/blob/251ad92bb5c2cd9a62477746a3db934b6dce0c4b/velas/velas-staking.js
                // https://explorer.solana.com/tx/2ffmtkj3Yj51ZWCEHG6jb6s78F73eoiQdqURV7z65kSVLiPcm8Y9NE45FgfgwbddJD8kfgCiTpmrEu7J8WKpAQeE
                await SolUtils.getAccountStaked(data.addressFrom)

                let start = 0
                let lastSeed = await SolTmpDS.getCache(data.addressFrom)
                if (typeof lastSeed !== 'undefined' && lastSeed && typeof lastSeed.seed !== 'undefined' && lastSeed.seed) {
                    start = lastSeed.seed * 1
                }
                for (let i = 1; i <= 10000; i++) {
                    const tmpSeed = (i + start).toString()
                    const stakeAccount = await PublicKey.createWithSeed(
                        fromPubkey,
                        tmpSeed,
                        StakeProgram.programId
                    )
                    stakeAddress = stakeAccount.toBase58()
                    const isUsed = SolUtils.checkAccountStaked(data.addressFrom, stakeAddress)
                    console.log(this._settings.currencyCode + ' SolTransferProcessor.sendTx  ' + data.addressFrom + ' rechecking seed ' + tmpSeed + ' ' + stakeAddress + ' ' + JSON.stringify(isUsed))
                    if (!isUsed) {
                        await SolTmpDS.saveCache(data.addressFrom, 'seed', tmpSeed)
                        seed = tmpSeed
                        break
                    }
                }

                if (!stakeAddress) {
                    throw new Error('Stake address seed is not found')
                }

                BlocksoftCryptoLog.log(this._settings.currencyCode + ' SolTransferProcessor.sendTx  ' + data.addressFrom + ' => ' + data.addressTo + ' ' + data.amount + ' stakeAddress ' + stakeAddress + ' seed ' + seed)

                const amount = data.amount * 1
                tx.add(StakeProgram.createAccountWithSeed({
                    authorized,
                    fromPubkey,
                    stakePubkey: new PublicKey(stakeAddress),
                    basePubkey: fromPubkey,
                    seed,
                    lamports: amount
                }))

                // https://github.com/solana-labs/solana-web3.js/blob/35f0608a8363d3878d045bdb09cdd13af696bc6b/test/transaction.test.ts
                tx.add(
                    StakeProgram.delegate({
                        stakePubkey: new PublicKey(stakeAddress),
                        authorizedPubkey: new PublicKey(data.addressFrom),
                        votePubkey: new PublicKey('beefKGBWeSpHzYBHZXwp5So7wdQGX6mu4ZHCsH3uTar')
                    })
                )

            } else {
                // @ts-ignore
                tx.add(
                    SystemProgram.transfer({
                        fromPubkey: new PublicKey(data.addressFrom),
                        toPubkey: new PublicKey(data.addressTo),
                        lamports: data.amount * 1
                    })
                )
            }
        } catch (e) {
            if (config.debug.cryptoErrors) {
                console.log(this._settings.currencyCode + ' SolTransferProcessor.sendTx  ' + data.addressFrom + ' => ' + data.addressTo + ' ' + data.amount + ' build error ')
                console.log(e)
            }
            BlocksoftCryptoLog.log(this._settings.currencyCode + ' SolTransferProcessor.sendTx  ' + data.addressFrom + ' => ' + data.addressTo + ' ' + data.amount + ' build error ' + e.message)
            this.trxError(e.message)
        }

        await SolUtils.signTransaction(tx, privateData.privateKey, data.addressFrom)

        // @ts-ignore
        const signedData = tx.serialize().toString('base64')
        BlocksoftCryptoLog.log(this._settings.currencyCode + ' SolTransferProcessor.sendTx  ' + data.addressFrom + ' => ' + data.addressTo + ' ' + data.amount, signedData)

        const result = {} as BlocksoftBlockchainTypes.SendTxResult
        try {
            const sendRes = await SolUtils.sendTransaction(signedData)
            BlocksoftCryptoLog.log(this._settings.currencyCode + ' SolTransferProcessor.sendTx  ' + data.addressFrom + ' => ' + data.addressTo + ' ' + data.amount, sendRes)
            if (typeof sendRes === 'undefined' || !sendRes || typeof sendRes === 'undefined') {
                throw new Error('SYSTEM_ERROR')
            }
            result.transactionHash = sendRes
            if (stakeAddress) {
                SolUtils.setAccountStaked(data.addressFrom, stakeAddress)
            }
            if (data.addressTo.indexOf('UNSTAKE') === 0) {
                await SolUtils.getAccountStaked(data.addressFrom, true)
            }
        } catch (e) {
            if (config.debug.cryptoErrors) {
                console.log(this._settings.currencyCode + ' SolTransferProcessor.sendTx  ' + data.addressFrom + ' => ' + data.addressTo + ' ' + data.amount + ' send error ')
                console.log(e)
            }
            BlocksoftCryptoLog.log(this._settings.currencyCode + ' SolTransferProcessor.sendTx  ' + data.addressFrom + ' => ' + data.addressTo + ' ' + data.amount + ' send error ' + e.message)
            this.trxError(e.message)
        }
        return result
    }


    trxError(msg: string) {
        if (msg.indexOf('insufficient funds for instruction') !== -1) {
            throw new Error('SERVER_RESPONSE_NOT_ENOUGH_BALANCE_SOL')
        } else {
            throw new Error(msg)
        }
    }
}
