import { NextPage } from "next"
import Head from "next/head"
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { useCallback, useState } from "react";
// import fetch, { FormData } from "node-fetch";
import { ShadowFile, ShdwDrive } from "@shadow-drive/sdk";
import { JsonMetadata, Metaplex, Pda, findMetadataPda } from "@metaplex-foundation/js";
import { CreateInstructionAccounts, PROGRAM_ID, createCreateInstruction, CreateInstructionArgs } from "../../lib/generated";
import { WalletMultiButton, WalletDisconnectButton } from "@solana/wallet-adapter-react-ui";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletNotConnectedError } from "@solana/wallet-adapter-base";
import { PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";
import { Wallet, web3 } from "@project-serum/anchor";
import { findProgramAddressSync } from "@project-serum/anchor/dist/cjs/utils/pubkey";
import dynamic from "next/dynamic";
import { POT_TAG } from "../../lib/constants";
import { useRouter } from 'next/router'
import { ToastContainer, toast, Zoom, Bounce } from 'react-toastify';
import "react-toastify/dist/ReactToastify.css"

const WalletMultiButtonDynamic = dynamic(
    async () => (await import('@solana/wallet-adapter-react-ui')).WalletMultiButton,
    { ssr: false }
);

type UploadResponse = {
    fileName: string,
    signatureImage: string,
    signatureMetadata: string
}

async function uploadSoap(soapName: string, soapDescription: string, imageFile: File, soapAddress: string) {
    // Return value is a link to the JSON metadata URI on Shadow Drive
    // EG. https://shdw-drive.genesysgo.net/4T16TQNnnc1x96avUQzQZ9qHMo54sS4tsuEUW2bumHtu/BvGw2bJ9p61Zp4RWW8v7HELEPNi6d2hsXuGg3h1jmVYw.json
    // This function uploads the soap's image to a specified Shadow Drive bucket,
    // assembles a json metadata with it and uploads that too to shadow.
    // Both the image and json file use the same uniquely generated filename from /api/signShdw

    // Request to pre-sign message with the filename on the backend
    const shadowSigner = await fetch("/api/signShdw", {
        method: "POST",
        headers: {
            "content-type": "application/json"
        },
        body: JSON.stringify({
            imageFileName: imageFile.name,
            soapAddress: soapAddress
        })
    });

    const signShdwJsonResponse = (await shadowSigner.json());

    // Upload image to ShadowDrive
    const formData = new FormData();
    formData.append("file", imageFile, signShdwJsonResponse.uniqueFileNameImage);
    formData.append("message", signShdwJsonResponse.signedMessageImage as string);
    formData.append("signer", process.env.NEXT_PUBLIC_SOAP_PUBKEY as string);
    formData.append("storage_account", process.env.NEXT_PUBLIC_SHDW_SOAP_BUCKET as string);
    formData.append("fileNames", [signShdwJsonResponse.uniqueFileNameImage].toString());
    const imageUploadResponse = await fetch("https://shadow-storage.genesysgo.net/upload", {
        method: "POST",
        body: formData
    });

    const imageUri = (await imageUploadResponse.json()).finalized_locations[0];
    console.log("Shadow Soap image URI: ", imageUri)


    // Create Metadata JSON file for Soap
    const soapMetadata = createMetadata(soapName, soapDescription, imageUri)
    console.log("Soap metadata: ", soapMetadata)

    const metadataFile = new File([JSON.stringify(soapMetadata)], signShdwJsonResponse.uniqueFileNameJson, { type: "text/plain" })

    // Upload metadata to ShadowDrive
    const formDataJson = new FormData();
    formDataJson.append("file", metadataFile, signShdwJsonResponse.uniqueFileNameJson);
    formDataJson.append("message", signShdwJsonResponse.signedMessageJson as string);
    formDataJson.append("signer", process.env.NEXT_PUBLIC_SOAP_PUBKEY as string);
    formDataJson.append("storage_account", process.env.NEXT_PUBLIC_SHDW_SOAP_BUCKET as string);
    formDataJson.append("fileNames", [signShdwJsonResponse.uniqueFileNameJson].toString());
    const JsonUploadResponse = await fetch("https://shadow-storage.genesysgo.net/upload", {
        method: "POST",
        body: formDataJson
    });

    const jsonUri = (await JsonUploadResponse.json()).finalized_locations[0];
    console.log("Shadow Soap JSON URI: ", jsonUri)

    return [jsonUri]

}

function createMetadata(name: string, description: string, imageUri: string) {
    // NFT Metadata
    const jsonMetadata = {
        name: name,
        symbol: "SOAP",
        description: description,
        seller_fee_basis_points: 10000,
        image: imageUri,
        // external_url: req.body.external_url,
        // attributes: req.body.attributes,
        properties: {
            category: "image"
        },
        collection: {
            name: "SOAP",
            family: "SOAP"
        }
    }

    return jsonMetadata;
}


const Creator: NextPage = (props) => {
    const router = useRouter()
    const [name, setName] = useState();
    const [loading, setLoading] = useState(false)
    const [description, setDescription] = useState();
    const [image, setImage] = useState<File | undefined>();
    const [soap, setSoap] = useState<string>()
    const { connection } = useConnection();
    const { publicKey, sendTransaction } = useWallet();
    const [errors, setErrors] = useState({
        wallet: ""
    })

    const notifySoapCreated = () => toast("Soap Created! Redirecting...");
    const notifySoapDismissed = () => toast.error("Transaction rejected!",);
    // toast.error("Error. Please try again");
    // toast.success("Success!")
    // toast.info("Info")
    // toast.warn("Warning")

    const handleNameChange = (event) => {
        setName(event.target.value);
    };

    const handleDescriptionChange = (event) => {
        setDescription(event.target.value);
    };

    const handleImageChange = (event) => {
        const MAX_FILE_SIZE = 3000; // 3MB
        const fileSizeKiloBytes = event.target.files[0].size / 1024;
        if (fileSizeKiloBytes > MAX_FILE_SIZE) {
            alert("File size is greater than maximum limit of 3MB.");
            return;
        } else if (fileSizeKiloBytes < MAX_FILE_SIZE) {
            setImage(event.target.files[0]);
        }
    };

    const handleSubmit = (event) => {
        event.preventDefault();
    };

    const submitSoapCreation = useCallback(async () => {
        setLoading(true)
        if (!publicKey) throw new WalletNotConnectedError();
        console.log("Image: ", image)
        if (!image) {
            alert("You did not upload an image.");
            return;
        }
        if (!name || !description) {
            alert("Fill out all the details.")
        }

        // Create new keypair to use as soap address
        const newSoapKeypair = Keypair.generate()

        const jsonUri = await uploadSoap(name, description, image, newSoapKeypair.publicKey.toBase58());
        const soapAddress = newSoapKeypair.publicKey

        const pot = Pda.find(PROGRAM_ID, [POT_TAG, soapAddress.toBuffer(), publicKey.toBuffer()])
        console.log("Pot Address: ", pot.toBase58())
        const metadataAddress = Metaplex.make(connection).nfts().pdas().metadata(
            {
                mint: newSoapKeypair.publicKey,
            }

        );
        console.log("Soap metadata Address:", metadataAddress.toBase58())

        const ixAccs: CreateInstructionAccounts = {
            payer: publicKey,
            // userProfile: publicKey,
            pot: pot,
            mintAccount: newSoapKeypair.publicKey,
            metadataAccount: metadataAddress,
            metadataProgram: TOKEN_METADATA_PROGRAM_ID
        }

        const ixArgs: CreateInstructionArgs = {
            soapTitle: name,
            soapSymbol: "SOAP",
            soapUri: jsonUri.toString()
        }

        const ix = createCreateInstruction(
            ixAccs,
            ixArgs,
            PROGRAM_ID
        )

        const {
            context: { slot: minContextSlot },
            value: { blockhash, lastValidBlockHeight }
        } = await connection.getLatestBlockhashAndContext();

        const transaction = new Transaction({
            feePayer: publicKey,
            lastValidBlockHeight,
            blockhash: blockhash
        }).add(ix)

        // Need to sign with the new soaps keypair
        transaction.partialSign(newSoapKeypair)

        console.log("Serialized TX: ", transaction.serialize({ requireAllSignatures: false }).toString('base64'))

        const signature = await sendTransaction(transaction, connection, { minContextSlot }).catch(e => {
            setErrors({ wallet: "AHH" })
            console.log("Error in sending transaction: ", e)
            notifySoapDismissed()
        });

        if (!signature) return setLoading(false)

        console.log("Signature: ", signature)

        await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature });
        console.log("Soap minted. TX: ", signature)
        notifySoapCreated()
        setSoap(soapAddress.toBase58())

        // Navigate to soap fundpot page. Justin wont like this lmao
        router.push(`${router.asPath}/fundPot?soapAddress=${soapAddress.toBase58()}`)

        // setLoading(false)
    }, [publicKey, sendTransaction, connection, image, name, description, soap]);


    return (
        <div className="px-5 flex justify-center items-center pt-8">
            <Head>
                <title>Create a Soap</title>
                <meta name="description" content="Create a Soap" />
                <link rel="icon" href="/favicon.ico" />
                <link rel="apple-touch-icon" href="/favicon.ico" />
            </Head>
            <ToastContainer autoClose={4000} draggable={false} transition={Zoom} />
            <main className="w-full max-w-md">
                <div className="m-6 justify-center items-center w-auto flex">
                    <WalletMultiButtonDynamic />
                </div>
                <form onSubmit={handleSubmit} className="bg-white shadow-md rounded px-8 pt-6 pb-8 mb-4">
                    <label className="block text-gray-700 text-sm font-bold mb-2">
                        Soap Name:
                        <input type="text" value={name} onChange={handleNameChange} className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline" />
                    </label>
                    <label className="block text-gray-700 text-sm font-bold mb-2">
                        Soap Description:
                        <textarea value={description} onChange={handleDescriptionChange} className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline"></textarea>
                    </label>
                    <label className="block text-gray-700 text-sm font-bold mb-2">
                        Image:
                        <input type="file" accept="image/jpeg, image/png" onChange={handleImageChange} className="shadow appearance-none border rounded w-full py-2 px-3 text-gray-700 leading-tight focus:outline-none focus:shadow-outline" />
                    </label>
                    <button onClick={submitSoapCreation} disabled={!publicKey || !name || !image || loading} className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline disabled:bg-slate-400">
                        {
                            loading ? <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" className="w-6 h-6 animate-spin">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                            </svg>
                                : "Create Soap"
                        }
                    </button>
                    {/* <div className="text-gray-800">
                        <button onClick={notifySoapCreated} className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:shadow-outline disabled:bg-slate-400">Notify !</button>
                    </div>
                    {soap && (
                        <>
                            <label className="block text-gray-700 text-sm font-bold mb-2">
                                Soap Created. Redirecting, please wait...
                            </label>
                            <label className="block text-gray-700 text-sm font-bold mb-2">
                                {soap}
                            </label>
                        </>
                    )} */}
                </form>
            </main>
        </div>

    )
}

export default Creator